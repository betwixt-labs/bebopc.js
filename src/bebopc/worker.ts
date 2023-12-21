import { posix as path } from "node:path";

import WASI, { createFileSystem } from "wasi-js";
import browserBindings from "wasi-js/dist/bindings/browser";
import { WASIExitError, WASIFileSystem } from "wasi-js/dist/types";

import { memoize } from "../internal/helpers";
import bebopcWasmUrl from "./bebopc.wasm?url";
import { WorkerResponse } from "./types";

const getModule = memoize(() =>
  WebAssembly.compileStreaming(fetch(bebopcWasmUrl))
);


export async function runBebopc(
  files: Map<string, string>,
  args: string[]
): Promise<WorkerResponse> {
  const fs = createFileSystem([
    {
      type: "mem",
      contents: Object.fromEntries(files),
    },
  ]);

  let stdout = "";
  let stderr = "";
  let sab: Int32Array | undefined;
  const wasi = new WASI({
    args,
    env: {
      RUST_BACKTRACE: "1",
    },
    // Workaround for bug in wasi-js; browser-hrtime incorrectly returns a number.
    bindings: {
      ...browserBindings,
      fs,
      hrtime: (...args): bigint => BigInt(browserBindings.hrtime(...args)),
    },
    preopens: {
      "/": "/",
    },
    sendStdout: (data: Uint8Array): void => {
      stdout += new TextDecoder().decode(data);
    },
    sendStderr: (data: Uint8Array) => {
      stderr += new TextDecoder().decode(data);
    },
    sleep: (ms: number) => {
      sab ??= new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(sab, 0, 0, Math.max(ms, 1));
    },
  });
  const module = await getModule();
  let imports = wasi.getImports(module);
  imports = {
    wasi_snapshot_preview1: {
      ...imports.wasi_snapshot_preview1,
      sock_accept: () => -1,
    },
  };
  const instance = await WebAssembly.instantiate(module, imports);
  let exitCode: number;
  try {
    wasi.start(instance);
    exitCode = 0;
  } catch (e) {
    if (e instanceof WASIExitError) {
      exitCode = e.code ?? 127;
    } else {
      return (e as any).toString();
    }
  }

  if (exitCode !== 0) {
    return { exitCode, stdErr: stderr, stdOut: stdout };
  }

  let output = "";

  if (
    (args.includes("build") && !args.includes("--stdout")) ||
    args.includes("--init")
  ) {
    for (const p of walk(fs, "/")) {
      if (files.has(p)) continue;
      output += `// @filename: ${p}\n`;
      output += fs.readFileSync(p, { encoding: "utf8" });
      output += "\n\n";
    }
    return { exitCode, stdErr: stderr, stdOut: output.trim() };
  }
  return { exitCode, stdErr: stderr, stdOut: stdout };
}

function* walk(fs: WASIFileSystem, dir: string): Generator<string> {
  for (const p of fs.readdirSync(dir)) {
    const entry = path.join(dir, p);
    const stat = fs.statSync(entry);
    if (stat.isDirectory()) {
      yield* walk(fs, entry);
    } else if (stat.isFile()) {
      yield entry;
    }
  }
}
