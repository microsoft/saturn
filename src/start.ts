#!/usr/bin/env node
import { CLI_HELP_TEXT, parseCliOptions } from './cli';
import { runSaturn } from './runSaturn';
import { consoleLogger, describeError } from './util';

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (options === undefined) {
    consoleLogger.info(CLI_HELP_TEXT);
    return;
  }

  const summary = await runSaturn({ ...options, logger: consoleLogger });
  const errorCount = summary.outcomes.filter((outcome) => outcome.status === 'error').length;
  if (errorCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  consoleLogger.error(describeError(error));
  process.exitCode = 1;
});
