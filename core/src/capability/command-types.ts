export type ParsedCommand =
  | { kind: 'segments'; segments: string[] }
  | { kind: 'unsupported'; construct: string }
  | { kind: 'unavailable'; detail: string };

export interface ParsedCommandArgument {
  readonly source: string;
  readonly value: string | undefined;
  readonly dynamic: boolean;
  readonly tildeExpansion: boolean;
  readonly nested: readonly ParsedCommandInvocation[];
}

export interface ParsedCommandInvocation {
  readonly executable: string;
  readonly executableSource?: string;
  readonly executableDynamic?: boolean;
  readonly executableNested?: readonly ParsedCommandInvocation[];
  readonly arguments: readonly ParsedCommandArgument[];
  readonly nested: boolean;
  readonly pipeline: boolean;
}

export interface CommandInspection {
  readonly parsed: ParsedCommand;
  readonly invocations: readonly ParsedCommandInvocation[];
}
