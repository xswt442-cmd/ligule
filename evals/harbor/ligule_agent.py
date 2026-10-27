"""Harbor v0.25.0 installed-agent adapter for a built Ligule npm tarball."""

from __future__ import annotations

import hashlib
import json
import re
import shlex
import tarfile
import tempfile
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext


INSTALL_PREFIX = "/installed-agent"
PACKAGE_ROOT = f"{INSTALL_PREFIX}/node_modules/ligule"
TARBALL_TARGET = f"{INSTALL_PREFIX}/ligule.tgz"
REMOTE_EXPORTER = f"{PACKAGE_ROOT}/export_session.mjs"
MAX_MODEL_CALLS = 64
MAX_TASK_TIMEOUT_MS = 86_400_000
MAX_REQUEST_TIMEOUT_MS = 3_600_000
ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
RESERVED_API_KEY_ENV = {
    "LIGULE_HOME", "PATH", "HOME", "TMPDIR", "TMP", "TEMP",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS",
}
NODE_VERSION = re.compile(r"^v?(\d+)\.")


def release_manifest(path: str | Path) -> dict[str, str]:
    """Read the npm package identity without extracting the supplied tarball."""
    tarball = Path(path)
    if not tarball.is_absolute() or tarball.is_symlink() or not tarball.is_file():
        raise ValueError("ligule_tarball_must_be_an_absolute_regular_file")

    with tarfile.open(tarball, "r:gz") as archive:
        matches = [item for item in archive.getmembers() if item.name == "package/package.json"]
        if len(matches) != 1 or not matches[0].isfile() or matches[0].size > 1_000_000:
            raise ValueError("ligule_tarball_package_manifest_invalid")
        stream = archive.extractfile(matches[0])
        if stream is None:
            raise ValueError("ligule_tarball_package_manifest_unreadable")
        try:
            manifest = json.loads(stream.read().decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as error:
            raise ValueError("ligule_tarball_package_manifest_invalid") from error

    if not isinstance(manifest, dict) or manifest.get("name") != "ligule":
        raise ValueError("ligule_tarball_package_name_invalid")
    version = manifest.get("version")
    if not isinstance(version, str) or not version.strip():
        raise ValueError("ligule_tarball_package_version_invalid")
    digest = hashlib.sha256(tarball.read_bytes()).hexdigest()
    return {"name": "ligule", "version": version, "sha256": digest}


def checked_run_limits(model_calls: int, timeout_ms: int, request_timeout_ms: int) -> None:
    if not isinstance(model_calls, int) or isinstance(model_calls, bool) or not 1 <= model_calls <= MAX_MODEL_CALLS:
        raise ValueError("ligule_model_calls_out_of_range")
    if not isinstance(timeout_ms, int) or isinstance(timeout_ms, bool) or not 1 <= timeout_ms <= MAX_TASK_TIMEOUT_MS:
        raise ValueError("ligule_task_timeout_out_of_range")
    if (not isinstance(request_timeout_ms, int) or isinstance(request_timeout_ms, bool)
            or not 1 <= request_timeout_ms <= min(timeout_ms, MAX_REQUEST_TIMEOUT_MS)):
        raise ValueError("ligule_request_timeout_out_of_range")


class LiguleAgent(BaseInstalledAgent):
    """Run the exact supplied tarball and export its canonical Session as ATIF."""

    capabilities = AgentCapabilities(atif=True)

    def __init__(
        self,
        logs_dir: Path,
        *,
        ligule_tarball: str,
        ligule_api: str,
        ligule_base_url: str,
        ligule_model: str | None = None,
        ligule_api_key_env: str = "LIGULE_API_KEY",
        ligule_model_calls: int = 5,
        ligule_timeout_ms: int = 3_600_000,
        ligule_request_timeout_ms: int = 120_000,
        **kwargs: Any,
    ) -> None:
        self.tarball_path = Path(ligule_tarball)
        self.package = release_manifest(self.tarball_path)
        self.ligule_api = ligule_api
        self.ligule_base_url = ligule_base_url
        self.ligule_model = ligule_model
        self.ligule_api_key_env = ligule_api_key_env
        self.ligule_model_calls = ligule_model_calls
        self.ligule_timeout_ms = ligule_timeout_ms
        self.ligule_request_timeout_ms = ligule_request_timeout_ms
        self._last_trial: dict[str, str] | None = None
        checked_run_limits(ligule_model_calls, ligule_timeout_ms, ligule_request_timeout_ms)
        if ligule_api not in {"messages", "chat-completions"}:
            raise ValueError("ligule_api_unsupported")
        if urlsplit(ligule_base_url).scheme not in {"http", "https"} or not urlsplit(ligule_base_url).netloc:
            raise ValueError("ligule_base_url_invalid")
        if (not ENV_NAME.fullmatch(ligule_api_key_env) or ligule_api_key_env in RESERVED_API_KEY_ENV
                or ligule_api_key_env.startswith(("NODE_", "LD_", "DYLD_"))):
            raise ValueError("ligule_api_key_env_invalid")
        super().__init__(logs_dir, version=self.package["version"], **kwargs)
        self.ligule_model = ligule_model or self.model_name
        if not self.ligule_model:
            raise ValueError("ligule_model_required")
        if len(self.ligule_model) > 256:
            raise ValueError("ligule_model_invalid")

    @staticmethod
    def name() -> str:
        return "ligule"

    async def _prepare_install_prefix(self, environment: BaseEnvironment) -> None:
        owner = environment.default_user
        if owner is not None:
            quoted_owner = shlex.quote(str(owner))
            command = (
                "test -d /installed-agent && test ! -L /installed-agent "
                "&& test -z \"$(ls -A /installed-agent)\" "
                f"&& chown -- {quoted_owner} /installed-agent && chmod 0755 /installed-agent"
            )
            await self.exec_as_root(environment, command=command, timeout_sec=30)
        await self.exec_as_agent(
            environment,
            command=(
                "test -d /installed-agent && test ! -L /installed-agent "
                "&& test -w /installed-agent && test -x /installed-agent"
            ),
            timeout_sec=30,
        )

    async def install(self, environment: BaseEnvironment) -> None:
        runtime = await self.exec_as_agent(environment, command="node --version && npm --version", timeout_sec=30)
        first_line = runtime.stdout.splitlines()[0] if runtime.stdout.splitlines() else ""
        match = NODE_VERSION.match(first_line)
        if match is None or int(match.group(1)) < 24:
            raise RuntimeError("ligule_requires_node_24_or_newer")
        await self._prepare_install_prefix(environment)
        await self._upload_agent_owned_file(environment, self.tarball_path, TARBALL_TARGET)
        hash_script = "const fs=require('node:fs');const c=require('node:crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync(process.argv[1])).digest('hex'))"
        remote_hash = await self.exec_as_agent(
            environment,
            command=f"node -e {shlex.quote(hash_script)} {shlex.quote(TARBALL_TARGET)}",
            timeout_sec=30,
        )
        if remote_hash.stdout.strip() != self.package["sha256"]:
            raise RuntimeError("ligule_uploaded_tarball_digest_mismatch")
        await self.exec_as_agent(
            environment,
            command=(
                f"npm install --prefix {shlex.quote(INSTALL_PREFIX)} {shlex.quote(TARBALL_TARGET)} "
                "--no-audit --no-fund"
            ),
            timeout_sec=900,
        )
        probe = (
            "Promise.all([import('@ligule/core/session/atif.js'),import('@ligule/core/kernel/result.js')])"
            ".then(([a,r])=>{if(typeof a.sessionTurnToAtif!=='function'||!(r.SPILL_NAME instanceof RegExp))process.exitCode=1})"
        )
        await self.exec_as_agent(
            environment,
            command=(
                f"cd {shlex.quote(PACKAGE_ROOT)} && node --input-type=module -e {shlex.quote(probe)}"
            ),
            timeout_sec=30,
        )

    async def setup(self, environment: BaseEnvironment) -> None:
        await super().setup(environment)
        source = Path(__file__).with_name("export_session.mjs")
        await self.exec_as_agent(
            environment,
            command=f"test ! -e {shlex.quote(REMOTE_EXPORTER)}",
            timeout_sec=30,
        )
        await self._upload_agent_owned_file(environment, source, REMOTE_EXPORTER)

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        api_key = self.extra_env.get(self.ligule_api_key_env)
        if api_key is None or api_key == "":
            raise RuntimeError("ligule_provider_credential_missing")
        trial_id = uuid.uuid4().hex
        home = f"/tmp/ligule-eval-{trial_id}"
        sessions = f"{home}/sessions"
        instruction_path = f"{home}/instruction.txt"
        logs_path = self.environment_logs_dir.as_posix()
        await self.exec_as_agent(environment, command=f"mkdir -p {shlex.quote(home)}", timeout_sec=30)
        with tempfile.TemporaryDirectory(prefix="ligule-harbor-instruction-") as temporary:
            source = Path(temporary) / "instruction.txt"
            source.write_text(instruction, encoding="utf-8")
            await self._upload_agent_owned_file(environment, source, instruction_path)

        arguments = [
            "node", REMOTE_EXPORTER, "run",
            "--instruction-file", instruction_path,
            "--session-directory", sessions,
            "--home-directory", home,
            "--logs-directory", logs_path,
            "--cli", f"{INSTALL_PREFIX}/node_modules/.bin/ligule",
            "--agent-version", self.package["version"],
            "--model-api", self.ligule_api,
            "--base-url", self.ligule_base_url,
            "--model", self.ligule_model,
            "--api-key-env", self.ligule_api_key_env,
            "--model-calls", str(self.ligule_model_calls),
            "--timeout-ms", str(self.ligule_timeout_ms),
            "--request-timeout-ms", str(self.ligule_request_timeout_ms),
        ]
        command = " ".join(shlex.quote(argument) for argument in arguments)
        try:
            await self.exec_as_agent(
                environment,
                command=command,
                env={"LIGULE_HOME": home, self.ligule_api_key_env: api_key},
                timeout_sec=(self.ligule_timeout_ms + 30_000 + 999) // 1000,
            )
        finally:
            self._last_trial = {"home": home, "session_directory": sessions}

    def populate_context_post_run(self, context: AgentContext) -> None:
        if self._last_trial is None:
            return
        status_path = self.logs_dir / "ligule-result.json"
        if not status_path.is_file() or status_path.is_symlink():
            context.metadata = {**(context.metadata or {}), "ligule": {"state": "unknown", "result_file_missing": True}}
            return
        try:
            value = json.loads(status_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            context.metadata = {**(context.metadata or {}), "ligule": {"state": "unknown", "result_file_invalid": True}}
            return
        allowed = ("status", "state", "sessionId", "runId", "errorCode", "atifErrorCode")
        context.metadata = {**(context.metadata or {}), "ligule": {key: value[key] for key in allowed if key in value}}
