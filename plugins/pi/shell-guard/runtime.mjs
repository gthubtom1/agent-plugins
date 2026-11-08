import { execFile, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { evaluate } from './src/policy.mjs';
import { buildArgs, isIpcUnavailable, parseOutput, validateEverythingConfig } from './src/everything.mjs';

export const VERSION = '0.2.1';
const run = promisify(execFile);
const GUI_START_TIMEOUT = 5000;
const GUIDANCE = `Shell guard checks common bash command forms before execution and applies finite timeouts. It is a heuristic guard, not an operating-system sandbox.
- Use search_files for indexed filename/path lookup and scoped rg for file contents. Index absence, limited results and backend failure do not establish that a file does not exist.
- Name exact deletion targets. Only unambiguous current user input may grant a target; negated, quoted or uncertain intent requires confirmation. Never widen scope or rewrite a rejected command to evade a decision.
- Root/system targets remain protected. Unknown destructive forms require review; normal generated-file cleanup should stay usable.
- Long-lived jobs need bounded lifecycle and separate stdout/stderr; do not assume a pipe to head or a timeout command constrains traversal scope.
- A guard error blocks that shell call rather than silently allowing it. Other tools, arbitrary scripts, direct user shell commands and other extensions are not an OS security boundary.`;
const object = (properties, required = []) => ({type:'object',properties,required,additionalProperties:false});
const string = (description, maxLength = 512) => ({type:'string',description,maxLength});
function result(value) { return {content:[{type:'text',text:JSON.stringify(value,null,2)}],details:value}; }

// Resolve existing parents too; don't silently fall back on permission errors.
export function resolveReal(target) {
  let candidate = path.resolve(target);
  const tail = [];
  for (let depth = 0; depth < 128; depth++) {
    try { return path.join(realpathSync.native(candidate), ...tail); }
    catch (error) {
      if (!['ENOENT','ENOTDIR'].includes(error?.code)) throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      tail.unshift(path.basename(candidate)); candidate = parent;
    }
  }
  throw new Error('Path ancestry exceeds resolution budget');
}

function launchDetached(spawnFile, executable, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Everything GUI launch aborted')); return; }
    let child;
    let started = false;
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const onSpawn = () => {
      started = true;
      try { child.unref?.(); } catch (error) { finish(error); return; }
      finish();
    };
    const onError = (error) => {
      if (!started) finish(error);
    };
    try {
      child = spawnFile(executable, [], {detached:true, shell:false, windowsHide:true, stdio:'ignore'});
      if (!child || typeof child.once !== 'function') throw new TypeError('Everything GUI launcher returned no child process');
      child.once('spawn', onSpawn);
      child.once('error', onError);
      timer = setTimeout(() => finish(new Error('Everything GUI launch timed out')), GUI_START_TIMEOUT);
      timer.unref?.();
    } catch (error) {
      finish(error);
    }
  });
}

export function registerShellGuard(pi, dependencies = {}) {
  const policy = dependencies.evaluate ?? evaluate;
  const executeFile = dependencies.executeFile ?? run;
  const spawnFile = dependencies.spawn ?? spawn;
  const realpath = dependencies.realpath ?? resolveReal;
  let pendingInput = null;
  let userText = '';
  const reset = () => { pendingInput = null; userText = ''; };
  for (const name of ['session_start','session_tree','session_shutdown','agent_settled']) pi.on(name, reset);
  pi.on('input', event => {
    // Capture pre-template raw input. Extension-authored user messages are not grants.
    userText = '';
    pendingInput = ['interactive','rpc'].includes(event.source) && !event.streamingBehavior && typeof event.text === 'string'
      ? event.text : null;
  });
  const settings = () => {
    const all = pi.getSettings?.();
    const value = all?.shellGuard ?? {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid shellGuard settings');
    const esPath = process.env.PI_SHELL_GUARD_ES;
    return esPath ? {...value,everything:{...value.everything,esPath}} : value;
  };
  pi.on('before_agent_start', event => {
    userText = event.messageType === 'user' && event.prompt === pendingInput ? pendingInput : '';
    pendingInput = null;
    const section = event.systemPromptOptions?.sections;
    if (section) section.shell_guard = GUIDANCE;
    else return {systemPrompt:`${event.systemPrompt ?? ''}\n\n${GUIDANCE}`};
  });

  const options = ctx => ({cwd:ctx.cwd,projectRoot:ctx.cwd,home:undefined,platform:process.platform,settings:settings(),userText,realpath});
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return;
    try {
      if (typeof event.input?.command !== 'string') throw new Error('Unsupported bash argument schema');
      const command = event.input.command;
      const initialOptions = options(ctx);
      const decision = policy(command,{...initialOptions,explicitTimeout:event.input.timeout});
      if (!decision || !['allow','confirm','block'].includes(decision.action)) throw new Error('Invalid policy decision');
      if (decision.action === 'block') return {block:true,reason:decision.reason ?? 'shell-guard: blocked'};
      if (decision.action === 'confirm') {
        if (ctx.hasUI !== true || typeof ctx.ui?.select !== 'function') return {block:true,reason:`需要确认：${decision.reason ?? '无法确定删除范围'}。当前宿主没有确认界面；请明确具体目标。`};
        if (command.length > 6000) return {block:true,reason:'待确认命令过长，请拆成可完整审阅的具体操作。'};
        const choice = await ctx.ui.select(`确认这一次操作？\n${decision.reason ?? ''}\n\n工作目录：${ctx.cwd}\n${command}`,['取消','仅允许本次'],{signal:ctx.signal,timeout:120000});
        if (choice !== '仅允许本次' || ctx.signal?.aborted) return {block:true,reason:'操作未获确认（取消、超时或中止）。'};
        // Re-evaluate filesystem identity immediately before execution. Never cache approval.
        const fresh = policy(command,{...options(ctx),explicitTimeout:event.input.timeout});
        if (JSON.stringify(fresh) !== JSON.stringify(decision)) return {block:true,reason:'等待确认期间目标或策略发生变化，请重新审阅操作。'};
      }
      if (event.input.command !== command) return {block:true,reason:'待执行命令在确认期间发生变化。'};
      if (!Number.isFinite(decision.timeout) || decision.timeout <= 0 || decision.timeout > 2147483) throw new Error('Policy returned an invalid timeout');
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
        data = {version:VERSION,module:import.meta.url,executed:false,decision:policy(command,{...options(ctx),userText:''}),note:'Dry assessment only; does not execute, approve or change settings.'};
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
          await launchDetached(spawnFile,guiPath,signal);
        } catch (launchError) {
          throw new Error(`Everything auto-start failed (${launchError?.code ?? launchError?.name ?? 'error'}); No absence conclusion.`);
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
