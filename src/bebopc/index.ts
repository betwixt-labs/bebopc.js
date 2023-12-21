
import { posix as path } from "node:path";

import { memoize } from "../internal/helpers";
import {
  BebopConfig,
  BuildOptions,
  CommandBuilder,
  CompilerError,
  CompilerException,
  CompilerOutput,
  Diagnostic,
  Flag,
  FlagValue,
  GeneratedFile,
  GeneratorConfig,
  RootOptions,
  Severity,
  SubCommand,
  WorkerResponse
} from "./types";

const generatorConfigToString = (config: GeneratorConfig) => {
  const [alias] = Object.keys(config);
  const [body] = Object.values(config);
  const options = Object.entries(body.options || {})
    .map(([key, value]) => `${key}=${value}`)
    .join(",");

  let result = `${alias}:${body.outFile}`;
  if (body.services) {
    result += `,${body.services}`;
  }
  if (body.emitNotice) {
    result += ",emitNotice=true";
  }
  if (body.emitBinarySchema) {
    result += ",emitBinarySchema=true";
  }
  if (body.namespace) {
    result += `,namespace=${body.namespace}`;
  }
  if (options) {
    result += `,${options}`;
  }
  return result;
};

/**
 * Creates a command builder for bebopc.
 * @param parentArgs
 * @returns
 */
const createCommandBuilder = (parentArgs?: string[]) => {
  const args: string[] = parentArgs || ["bebopc"];
  const addFlag = (flag: Flag, value?: FlagValue) => {
    args.push(flag);
    if (value !== undefined) {
      if (Array.isArray(value)) {
        args.push(...value);
      } else {
        args.push(value);
      }
    }
    return { addFlag, addSubCommand, build };
  };

  const addSubCommand = (subCommand: SubCommand) => {
    args.push(subCommand);
    return createCommandBuilder(args);
  };

  const build = () => {
    return args;
  };

  return { addFlag, addSubCommand, build };
};

/*
 * Creates the worker and memoizing it so that it is only created once.
 */
const getWorker = memoize(
  () =>
    new ComlinkWorker<typeof import("./worker")>(
      new URL("worker", import.meta.url), { type: 'classic'}
    )
);


const addRootOptions = (options: RootOptions, builder: CommandBuilder) => {
  if (options.config) {
    builder.addFlag("--config", options.config);
  }
  if (options.trace) {
    builder.addFlag("--trace");
  }
  if (options.include) {
    builder.addFlag("--include", options.include);
  }
  if (options.exclude) {
    builder.addFlag("--exclude", options.exclude);
  }
  if (options.locale) {
    builder.addFlag("--locale", options.locale);
  }
  if (options.diagnosticFormat) {
    builder.addFlag("--diagnostic-format", options.diagnosticFormat);
  } else {
    builder.addFlag("--diagnostic-format", "json");
  }
};

const fileNameRegexp = /^\s*\/\/\s*@filename:\s*(.+)$/gim;

export const createFileMap = (input: string): Map<string, string> => {
  fileNameRegexp.lastIndex = 0;
  if (!fileNameRegexp.test(input)) {
    throw new CompilerError("error", "no input files found", 1);
  }
  const lines = input.split(/\r?\n/g);
  let currentFilename: string | undefined;
  let currentLines: string[] = [];

  const files = new Map<string, string>();
  function finalizeFile() {
    if (currentFilename) {
      files.set(currentFilename, currentLines.join("\n"));
    }
  }
  for (const line of lines) {
    fileNameRegexp.lastIndex = 0;
    const match = fileNameRegexp.exec(line);
    if (match) {
      finalizeFile();
      currentFilename = path.resolve("/", match[1]);
      currentLines = [];
      continue;
    }

    if (currentFilename) {
      currentLines.push(line);
    }
  }
  finalizeFile();
  return files;
};

const extLookupTable: Record<
  string,
  {
    ext: string;
    auxiliaryExt?: string;
  }
> = {
  cpp: { ext: "cpp", auxiliaryExt: "hpp" },
  cs: { ext: "cs" },
  dart: { ext: "dart" },
  py: { ext: "py" },
  rust: { ext: "rs" },
  ts: { ext: "ts" },
};

const createCompilerOutput = (
  files: Map<string, string>,
  configs: GeneratorConfig[],
  stdError: string
): CompilerOutput => {
  if (configs.length === 0) {
    throw new CompilerError("error", "no generators specified", 1);
  }

  let warnings: Diagnostic[] = [];
  let errors: Diagnostic[] = [];
  if (stdError) {
    try {
      const diagnostics = JSON.parse(stdError) as CompilerOutput;
      warnings = diagnostics.warnings;
      errors = diagnostics.errors;
    } catch (e) {
      if (e instanceof Error) {
        throw new CompilerError(
          "error",
          "error while parsing standard error",
          1,
          undefined,
          e
        );
      }

      throw e;
    }
  }

  const results: GeneratedFile[] = [];
  for (const config of configs) {
    const [alias, { outFile }] = Object.entries(config)[0];
    const resolvedOutFile = path.resolve("/", outFile);
    const extMatch = resolvedOutFile.match(/\.([^.]+)$/);
    if (!extMatch) {
      throw new CompilerError("error", "unable to determine extension", 1);
    }

    const extInfo = extLookupTable[alias];
    if (!extInfo) {
      throw new CompilerError(
        "error",
        "unable to lookup extension",
        1,
        undefined,
        { alias }
      );
    }

    const outFileMatch = [...files.keys()].find((f) =>
      f.endsWith(resolvedOutFile)
    );
    if (!outFileMatch) {
      throw new CompilerError(
        "error",
        "unable to find output file",
        1,
        undefined,
        { resolvedOutFile }
      );
    }

    const generatedFile: GeneratedFile = {
      name: outFileMatch,
      content: files.get(outFileMatch) ?? "",
      generator: alias,
    };

    if (extInfo.auxiliaryExt) {
      const outFileDir = path.dirname(resolvedOutFile);
      const auxiliaryFileMatch = [...files.keys()].find((f) => {
        const fileDir = path.dirname(f);
        return f.endsWith(`.${extInfo.auxiliaryExt}`) && fileDir === outFileDir;
      });

      if (auxiliaryFileMatch) {
        generatedFile.auxiliaryFile = {
          name: auxiliaryFileMatch,
          content: files.get(auxiliaryFileMatch) ?? "",
        };
      } else {
        throw new CompilerError(
          "error",
          "unable to find auxiliary file",
          1,
          undefined,
          { resolvedOutFile }
        );
      }
    }

    results.push(generatedFile);
  }

  return { warnings, errors, results };
};

async function runBebopc(
  files: Map<string, string>,
  args: string[]
): Promise<WorkerResponse> {
  const worker = getWorker();
  return worker.runBebopc(files, args);
}

function mapToGeneratorConfigArray(config?: BebopConfig): GeneratorConfig[] {
  if (!config?.generators) {
    return [];
  }
  return Object.entries(config.generators).map(([key, value]) => {
    return { [key]: value } as GeneratorConfig;
  });
}
/**
 * Tries to find any JSON objects in the stdError output and returns them as an array.
 */
const findErrorEntries = (stdError: string): object[] => {
  // Regular expression to identify JSON-like structures
  const jsonRegex = /{[\S\s]*?}/g;
  const jsonMatches = stdError.match(jsonRegex);
  const validObjects: object[] = [];
  if (jsonMatches) {
    for (const jsonString of jsonMatches) {
      try {
        validObjects.push(JSON.parse(jsonString));
      } catch {
        // Ignore parsing errors, continue to the next match
      }
    }
  }
  return validObjects;
};

const isCompilerException = (obj: unknown): obj is CompilerException => {
  if (!obj || typeof obj !== "object") {
    return false;
  }
  return "severity" in obj && "message" in obj && "errorCode" in obj;
};

const throwCompilerError = (stdError: string, exitCode: number): void => {
  const errorEntries = findErrorEntries(stdError);
  if (errorEntries && errorEntries.length > 0 && exitCode >= 400) {
    const compilerException = errorEntries.at(-1);
    if (isCompilerException(compilerException)) {
      throw new CompilerError(
        compilerException.severity,
        compilerException.message,
        compilerException.errorCode,
        compilerException.span
      );
    }
  }
  throw new CompilerError("error", stdError, exitCode);
};

const parseStandardError = (
  stdError: string,
  exitCode: number
): CompilerOutput => {
  const errorEntries = findErrorEntries(stdError);
  if (errorEntries.length === 0) {
    throw new CompilerError("error", stdError, exitCode);
  }
  if (exitCode < 400) {
    const compilerOutput = errorEntries[0];
    if ("warnings" in compilerOutput && "errors" in compilerOutput) {
      return compilerOutput as CompilerOutput;
    }
  }
  const compilerException = errorEntries.at(-1);
  if (isCompilerException(compilerException)) {
    throw new CompilerError(
      compilerException.severity as Severity,
      compilerException.message,
      compilerException.errorCode,
      compilerException.span
    );
  }
  throw new CompilerError("error", stdError, exitCode);
};

export const BebopCompiler = (
  files?: Map<string, string>,
  options?: RootOptions
) => {
  const fileMap = files ?? new Map<string, string>();
  const builder = createCommandBuilder();
  let bebopConfig: BebopConfig | undefined = undefined;
  if (options) {
    addRootOptions(options, builder);
    if (options.config) {
      const configContent = fileMap.get(options.config);
      if (!configContent) {
        throw new CompilerError("error", "bebop.json not found", 1, undefined, {
          config: options.config,
        });
      }
      bebopConfig = JSON.parse(configContent);
    }
  }
  return {
    getHelp: async (): Promise<string> => {
      builder.addFlag("--help");
      const response = await runBebopc(fileMap, builder.build());
      if (response.exitCode !== 0) {
        throwCompilerError(response.stdErr, response.exitCode);
      }
      if (!response.stdOut) {
        throwCompilerError(response.stdErr, response.exitCode);
      }
      return response.stdOut.trim();
    },
    getVersion: async (): Promise<string> => {
      builder.addFlag("--version");
      const response = await runBebopc(fileMap, builder.build());
      if (response.exitCode !== 0) {
        throwCompilerError(response.stdErr, response.exitCode);
      }
      if (!response.stdOut) {
        throwCompilerError(response.stdErr, response.exitCode);
      }
      return response.stdOut.trim();
    },
    init: async (): Promise<BebopConfig> => {
      builder.addFlag("--init");
      const response = await runBebopc(fileMap, builder.build());
      if (response.exitCode !== 0) {
        throwCompilerError(response.stdErr, response.exitCode);
      }
      if (!response.stdOut) {
        throwCompilerError(response.stdErr, response.exitCode);
      }
      const emittedFiles = createFileMap(response.stdOut);
      for (const [key, value] of emittedFiles.entries()) {
        if (key.endsWith("bebop.json")) {
          return JSON.parse(value);
        }
      }
      throw new CompilerError("error", "bebop.json not found", 1);
    },
    showConfig: async (): Promise<BebopConfig> => {
      builder.addFlag("--show-config");
      const response = await runBebopc(fileMap, builder.build());
      if (response.exitCode !== 0) {
        throwCompilerError(response.stdErr, response.exitCode);
      }
      if (!response.stdOut) {
        throwCompilerError(response.stdErr, response.exitCode);
      }
      return JSON.parse(response.stdOut);
    },
    listSchemas: async (): Promise<string[]> => {
      builder.addFlag("--list-schemas-only");
      const response = await runBebopc(fileMap, builder.build());
      if (response.exitCode !== 0) {
        throwCompilerError(response.stdErr, response.exitCode);
      }
      if (!response.stdOut) {
        return [];
      }
      return response.stdOut.trim().split(/\r?\n/);
    },
    langServer: async (): Promise<void> => {
      throw new Error("not implemented");
    },
    watch: async (): Promise<void> => {
      throw new Error("not implemented");
    },
    build: async (
      generators?: GeneratorConfig[],
      options?: BuildOptions
    ): Promise<CompilerOutput> => {
      const buildCommand = builder.addSubCommand("build");
      if (generators) {
        for (const generator of generators) {
          buildCommand.addFlag(
            "--generator",
            generatorConfigToString(generator)
          );
        }
      }
      if (options) {
        if (options.noEmit) {
          buildCommand.addFlag("--no-emit");
        }
        if (options.noWarn) {
          buildCommand.addFlag("--no-warn", options.noWarn.map(String));
        }
        if (options.writeToStdOut) {
          buildCommand.addFlag("--stdout");
        }
      }
      const response = await runBebopc(fileMap, buildCommand.build());
      if (response.exitCode !== 0) {
        return parseStandardError(response.stdErr, response.exitCode);
      }
      if (options?.noEmit) {
        // if empty likely no errors or warnings
        if (!response.stdErr) {
          return { warnings: [], errors: [] };
        }
        return parseStandardError(response.stdErr, response.exitCode);
      }
      if (!response.stdOut) {
        throwCompilerError(response.stdErr, response.exitCode);
      }
      if (options?.writeToStdOut) {
        const compilerOutput = JSON.parse(response.stdOut);
        if (
          !("warnings" in compilerOutput) ||
          !("errors" in compilerOutput) ||
          !("results" in compilerOutput)
        ) {
          throw new CompilerError("error", response.stdOut, response.exitCode);
        }
        return compilerOutput;
      }
      const emittedFiles = createFileMap(response.stdOut);
      return createCompilerOutput(
        emittedFiles,
        generators ?? mapToGeneratorConfigArray(bebopConfig),
        response.stdErr
      );
    },
  };
};
