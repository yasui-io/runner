#!/usr/bin/env node
/**
 * yasui-runner — CLI entry (04 §6).
 *
 * yasui-runner connect --code XXXX-XXXX [--name atlas] [--kind vps] [--api …]
 * yasui-runner start [--foreground] | stop | status [--json]
 * yasui-runner projects add <path> | list | remove <path> | trust <path>
 * yasui-runner config set <allow-bypass|redaction> <on|off>
 * yasui-runner rotate-token | doctor | update [--to <version>]
 * yasui-runner install-service [--uninstall]
 * yasui-runner conform --scenario <name> --code <pairing-code>
 */

import { Command } from 'commander'
import { RUNNER_VERSION } from '../version.js'
import { registerConnect } from './connect.js'
import { registerStart } from './start.js'
import { registerStop } from './stop.js'
import { registerStatus } from './status.js'
import { registerProjects } from './projects.js'
import { registerConfigSet } from './config-set.js'
import { registerRotateToken } from './rotate-token.js'
import { registerDoctor } from './doctor.js'
import { registerUpdate } from './update.js'
import { registerInstallService } from './install-service.js'
import { registerConform } from './conform.js'
import { registerSelfCheck } from './selfcheck.js'

const program = new Command()

program
  .name('yasui-runner')
  .description('Yasui agent host — runs coding-agent sessions on your machine, driven from the Yasui web UI')
  .version(RUNNER_VERSION)

registerConnect(program)
registerStart(program)
registerStop(program)
registerStatus(program)
registerProjects(program)
registerConfigSet(program)
registerRotateToken(program)
registerDoctor(program)
registerUpdate(program)
registerInstallService(program)
registerConform(program)
registerSelfCheck(program)

program.parseAsync(process.argv).catch((err: Error) => {
  process.stderr.write(`${err.message}\n`)
  process.exit(1)
})
