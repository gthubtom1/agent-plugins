import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { evaluate } from './src/policy.mjs';
import { parseTrashableRm, trashCommand } from './src/trash.mjs';
import { buildArgs, isBoundedTimeout, isIpcUnavailable, parseOutput, validateEverythingConfig } from './src/everything.mjs';

export const VERSION = '0.3.0';
const run = promisify(execFile);

const GUI_START_TIMEOUT = 5000;
const GUIDANCE = `Shell guard checks common bash command forms before execution and applies finite timeouts. It is a heuristic guard, not an operating-system sandbox.
- Use search_files for indexed filename/path lookup and scoped rg for file contents. Index absence, limited results and backend failure do not establish that a file does not exist.
- Ordinary project-local rm of one literal target is moved during Bash execution to TEMP/<unique-batch>/<original-name>; the original rm never executes.
- Roots, system/home/credential paths, .git, TEMP, known database path/file names, target/parent links and outside-project targets are protected. Unsupported deletion forms return an immediate tool error.
- Unsupported or uncertain commands return an immediate tool error/block; no UI is opened. Direct and nested calls use the same allow/trash/block policy.
- Long-lived jobs need bounded lifecycle and separate stdout/stderr; do not assume a pipe to head or a timeout command constrains traversal scope.
- A guard error blocks that shell call rather than silently allowing it. Other tools, arbitrary scripts, direct user shell commands and other extensions are not an OS security boundary.`;
const object = (properties, required = []) => ({type:'object',properties,required,additionalProperties:false});
const string = (description, maxLength = 512) => ({type:'string',description,maxLength});
function result(value) { return {content:[{type:'text',text:JSON.stringify(value,null,2)}],details:value}; }

export function registerShellGuard(pi, dependencies = {}) {
  const policy = dependencies.evaluate ?? evaluate;
  const executeFile = dependencies.executeFile ?? run;
  const settings = () => {
    const all = pi.getSettings?.();
    const value = all?.shellGuard ?? {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid shellGuard settings');
    const esPath = process.env.PI_SHELL_GUARD_ES;
    return esPath ? {...value,everything:{...value.everything,esPath}} : value;
  };
  pi.on('before_agent_start', event => {
    const section = event.systemPromptOptions?.sections;
    if (section) section.shell_guard = GUIDANCE;
    else return {systemPrompt:`${event.systemPrompt ?? ''}\n\n${GUIDANCE}`};
  });

  const options = ctx => ({cwd:ctx.cwd,projectRoot:ctx.cwd,home:undefined,platform:process.platform,settings:settings()});
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return;
    try {
      if (typeof event.input?.command !== 'string') throw new Error('Unsupported bash argument schema');
      const command = event.input.command;
      const initialOptions = options(ctx);
      const decision = policy(command,{...initialOptions,explicitTimeout:event.input.timeout});
      if (!decision || !['allow','trash','block'].includes(decision.action)) throw new Error('Invalid policy decision');
      if (decision.action === 'block') return {block:true,reason:decision.reason ?? 'shell-guard: blocked'};
      if (!Number.isFinite(decision.timeout) || decision.timeout <= 0 || decision.timeout > 2147483) throw new Error('Policy returned an invalid timeout');

      if (decision.action === 'trash') {
        const trashPlan = parseTrashableRm(command, initialOptions);
        if (!trashPlan) return {block:true,reason:'shell-guard：此删除形式或目标不能安全移入项目 TEMP，已阻止；原始删除命令未执行。请使用单个项目内字面目标；TEMP、.git、数据库和受保护路径不能自动清理。'};
        // Mutate only arguments here. Actual I/O belongs to Bash execution,
        // after every later tool_call handler has had a chance to block.
        event.input.command = trashCommand(trashPlan);
      }
      // Enforce the result even when a caller supplied an explicit excessive timeout.
      event.input.timeout = decision.timeout;
    } catch (error) {
      // An assessment failure must never silently approve a destructive command.
      return {block:true,reason:`shell-guard 无法安全判定，已阻止本次调用：${String(error?.message ?? error).slice(0,300)}`};
    }
  });

  pi.registerCommand('shell-guard', {
    description:'Show loaded guard version/path or assess a command without executing it',
    handler:async (args, ctx) => {
      const text = (args ?? '').trim();
      let data;
      if (text.startsWith('check ')) {
        const command = text.slice(6).trim();
        if (!command || command.length > 6000) throw new Error('check需要不超过6000字符的命令。');
        data = {version:VERSION,module:import.meta.url,executed:false,decision:policy(command,options(ctx)),note:'Dry assessment only; does not execute, approve or change settings.'};
      } else {
        if (text && text !== 'status') throw new Error('用法：/shell-guard [status|check <command>]');
        const config = settings();
        data = {version:VERSION,module:import.meta.url,cwd:ctx.cwd,configuredTimeouts:config.timeout ?? '60/120/900, ceiling 1800',everythingConfigured:Boolean(config.everything?.esPath),boundary:'heuristic bash preflight; not an OS sandbox'};
      }
      pi.sendMessage({customType:'shell-guard-status',display:true,content:JSON.stringify(data,null,2)},{triggerTurn:false});
    },  });

  pi.registerTool({
    name:'search_files',label:'Search indexed file names',
    description:'Search the Everything filename/path index, bounded to 200 results and 24KB output. Not content search. Empty/limited/stale index results do not prove file absence. Use regex for exact names.',
    promptSnippet:'Find indexed filenames; use scoped rg for contents',
    parameters:object({query:{...string('Everything query or filename regex'),minLength:1},limit:{type:'integer',minimum:1,maximum:200},path:string('Absolute directory filter'),regex:{type:'boolean'},foldersOnly:{type:'boolean'}},['query']),
    annotations:{readOnlyHint:true,openWorldHint:false,idempotentHint:true},
    async execute(_id, params, signal) {
      const config = settings();
      const everythingConfig = validateEverythingConfig(config.everything ?? {});
      if (config.everything?.enabled === false || !everythingConfig.esPath) throw new Error('Everything backend unavailable: configure shellGuard.everything.esPath. This is not an empty search result.');
      const {esPath, guiPath, autostart} = everythingConfig;
      const limit = params.limit ?? config.everything?.maxResults ?? 50;
      const args = buildArgs(params.query,{limit,path:params.path,regex:params.regex,foldersOnly:params.foldersOnly});
      const cliOptions = {timeout:15000,maxBuffer:1024*1024,windowsHide:true,signal,encoding:'utf8',shell:false};
      const runCli = () => executeFile(esPath,args,cliOptions);
      const queryFailure = (error) => new Error(`Everything query failed (${error?.code ?? error?.name ?? 'error'}); index/service unavailable or query aborted. No absence conclusion.`);
      let stdout;
      try {
        ({stdout} = await runCli());
      } catch (error) {
        if (!autostart || !isIpcUnavailable(error)) throw queryFailure(error);
        try {
          // Start the configured GUI once. A long-lived GUI may be killed by
          // this bounded launch call; the service gets one exact CLI retry.
          await executeFile(guiPath,[],{timeout:GUI_START_TIMEOUT,maxBuffer:64*1024,windowsHide:true,signal,encoding:'utf8',shell:false});
        } catch (launchError) {
          if (!isBoundedTimeout(launchError)) throw new Error(`Everything auto-start failed (${launchError?.code ?? launchError?.name ?? 'error'}); No absence conclusion.`);
        }
        try {
          // Retry the exact argv once. Do not rebuild or broaden the query.
          ({stdout} = await runCli());
        } catch (retryError) {
          throw queryFailure(retryError);
        }
      }
      const rows = parseOutput(stdout);
      const paths = []; let bytes = 0;
      for (const row of rows.slice(0,limit)) {
        const size = Buffer.byteLength(JSON.stringify(row),'utf8');
        if (bytes + size > 24000) break;
        bytes += size; paths.push(row);
      }
      return result({backend:'everything',query:params.query,path:params.path ?? null,count:paths.length,paths,limit,limited:rows.length >= limit,truncated:paths.length < rows.length,indexFreshness:'not_verified',note:'Filename index only. Limited or empty results do not establish file absence.'});
    },
  });
}
