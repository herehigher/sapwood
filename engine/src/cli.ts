#!/usr/bin/env node
// `sapwood` CLI. M0.5 ships `init`; status/stop and the full command surface land in M4.
import { loadConfig } from "./config.js";
import { init, InitError } from "./init.js";

async function main(argv: string[]): Promise<number> {
  if (argv[2] !== "init") {
    console.error("usage: sapwood init");
    return 2;
  }
  try {
    const { actions } = await init(loadConfig());
    for (const a of actions) console.log("•", a);
    console.log("init complete.");
    return 0;
  } catch (e) {
    // Expected, actionable failures (auth/scope) print clean; bugs still throw.
    if (e instanceof InitError) {
      console.error("init failed:", e.message);
      return 1;
    }
    throw e;
  }
}

main(process.argv)
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
