import asyncio
import json
import io
import os
import tempfile
import tarfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from ligule_agent import LiguleAgent, TARBALL_TARGET, release_manifest

TEMP_ROOT = Path(os.environ.get("LIGULE_EVAL_TEMP_DIR", Path(__file__).resolve().parents[3] / "testplace" / "tmp"))


def make_tarball(path: Path, manifest: dict[str, str]) -> None:
    content = json.dumps(manifest).encode("utf-8")
    with tarfile.open(path, "w:gz") as archive:
        item = tarfile.TarInfo("package/package.json")
        item.size = len(content)
        archive.addfile(item, io.BytesIO(content))


class FakeEnvironment:
    default_user = "harbor-agent"

    def __init__(self, digest: str, *, occupied: bool = False) -> None:
        self.digest = digest
        self.occupied = occupied
        self.owner = "root"
        self.commands: list[tuple[str | int | None, str]] = []
        self.uploads: list[str] = []

    async def exec(self, *, command: str, user: str | int | None = None, **_kwargs: object) -> SimpleNamespace:
        self.commands.append((user, command))
        text = command.split("set -o pipefail; ", 1)[-1]
        if user == "root":
            if "/installed-agent" not in text or "chown -- harbor-agent /installed-agent" not in text:
                return SimpleNamespace(return_code=1, stdout="", stderr="unexpected root write")
            if "-R" in text or self.occupied:
                return SimpleNamespace(return_code=1, stdout="", stderr="install prefix is not empty")
            self.owner = "harbor-agent"
            return SimpleNamespace(return_code=0, stdout="", stderr="")
        actor = self.default_user if user is None else str(user)
        if "node --version && npm --version" in text:
            return SimpleNamespace(return_code=0, stdout="v24.22.0\n11.0.0\n", stderr="")
        if "test -w /installed-agent" in text:
            code = 0 if self.owner == actor else 1
            return SimpleNamespace(return_code=code, stdout="", stderr="")
        if "node -e" in text:
            return SimpleNamespace(return_code=0, stdout=self.digest, stderr="")
        if text.startswith("npm install --prefix /installed-agent"):
            code = 0 if self.owner == actor else 1
            return SimpleNamespace(return_code=code, stdout="installed\n" if code == 0 else "", stderr="")
        return SimpleNamespace(return_code=0, stdout="", stderr="")


class HarborAdapterTests(unittest.TestCase):
    def test_tarball_identity_is_read_from_the_supplied_archive(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as directory:
            tarball = Path(directory) / "ligule-build.tgz"
            make_tarball(tarball, {"name": "ligule", "version": "0.1.1-dev"})
            info = release_manifest(tarball)
            self.assertEqual(info["name"], "ligule")
            self.assertEqual(info["version"], "0.1.1-dev")
            self.assertEqual(len(info["sha256"]), 64)

    def test_adapter_uses_harbor_025_capability_and_tarball_version(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as directory:
            tarball = Path(directory) / "ligule-build.tgz"
            make_tarball(tarball, {"name": "ligule", "version": "0.1.1-dev"})
            agent = LiguleAgent(
                logs_dir=Path(directory) / "logs",
                ligule_tarball=str(tarball),
                ligule_api="messages",
                ligule_base_url="https://api.example.test/v1",
                model_name="test-model",
            )
            self.assertEqual(agent.name(), "ligule")
            self.assertEqual(agent.version(), "0.1.1-dev")
            self.assertTrue(agent.capabilities.atif)
            self.assertEqual(agent.ligule_model, "test-model")

    def test_run_budgets_must_be_positive_and_bounded(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as directory:
            tarball = Path(directory) / "ligule-build.tgz"
            make_tarball(tarball, {"name": "ligule", "version": "0.1.1-dev"})
            with self.assertRaisesRegex(ValueError, "model_calls_out_of_range"):
                LiguleAgent(
                    logs_dir=Path(directory) / "logs",
                    ligule_tarball=str(tarball),
                    ligule_api="messages",
                    ligule_base_url="https://api.example.test/v1",
                    model_name="test-model",
                    ligule_model_calls=0,
                )

    def test_non_root_install_owns_only_the_empty_install_prefix(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as directory:
            tarball = Path(directory) / "ligule-build.tgz"
            make_tarball(tarball, {"name": "ligule", "version": "0.1.1-dev"})
            agent = LiguleAgent(
                logs_dir=Path(directory) / "logs",
                ligule_tarball=str(tarball),
                ligule_api="messages",
                ligule_base_url="https://api.example.test/v1",
                model_name="test-model",
            )

            async def record_upload(environment: FakeEnvironment, source: Path, target: str) -> None:
                if environment.owner != environment.default_user:
                    raise PermissionError("install directory was not prepared for the agent user")
                environment.uploads.append(target)

            agent._upload_agent_owned_file = record_upload
            environment = FakeEnvironment(agent.package["sha256"])
            asyncio.run(agent.install(environment))

            root_commands = [command for user, command in environment.commands if user == "root"]
            self.assertEqual(len(root_commands), 1)
            self.assertIn("chown -- harbor-agent /installed-agent", root_commands[0])
            self.assertIn("chmod 0755 /installed-agent", root_commands[0])
            self.assertNotIn("chown -R", root_commands[0])
            self.assertEqual(environment.uploads, [TARBALL_TARGET])
            self.assertTrue(any(command.split("set -o pipefail; ", 1)[-1].startswith(
                "npm install --prefix /installed-agent") for _user, command in environment.commands))

    def test_nonempty_install_prefix_is_refused_without_recursive_chown(self) -> None:
        with tempfile.TemporaryDirectory(dir=TEMP_ROOT) as directory:
            tarball = Path(directory) / "ligule-build.tgz"
            make_tarball(tarball, {"name": "ligule", "version": "0.1.1-dev"})
            agent = LiguleAgent(
                logs_dir=Path(directory) / "logs",
                ligule_tarball=str(tarball),
                ligule_api="messages",
                ligule_base_url="https://api.example.test/v1",
                model_name="test-model",
            )
            environment = FakeEnvironment(agent.package["sha256"], occupied=True)
            with self.assertRaises(RuntimeError):
                asyncio.run(agent.install(environment))
            self.assertEqual(environment.uploads, [])
            self.assertFalse(any("npm install --prefix /installed-agent" in command
                                 for _user, command in environment.commands))


if __name__ == "__main__":
    unittest.main()
