// ref0's plugin for OpenCode. ref0 writes this file; don't edit it.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hooks = {"hook":"hook","start":"session-start","UserPromptSubmit":"user-prompt-submit","PreToolUse":"pre-tool-use","PostToolUse":"post-tool-use","PostToolUseFailure":"post-tool-use-failure","Stop":"stop","SubagentStart":"subagent-start","SubagentStop":"subagent-stop","shown":"shown"};
const textBytes = 10000;
const mostSteps = 2000;
const mostPrompts = 100;
const editInput = { edit: ['path', 'oldString', 'newString', 'replaceAll'], write: ['path', 'content'] };
const waitMs = 15_000;
// Steps remembered from their start to their end, the oldest forgotten past this.
const mostOpenSteps = mostSteps * 4;
// How long a turn's `Stop` waits for its steps' ends, which OpenCode's events bring after its idle.
const settleMs = 2_000;
// OpenCode's shell tool, how many of its calls wait for their shells at most, and the line that
// tags one's command until its shell starts.
const shellTool = 'shell';
const mostAgentShells = 64;
const shellTag = /\n# ref0 shell ([0-9a-f]{16})$/;

// The origin's launcher, where the origin keeps its releases and it: none outside that layout.
const launcherOf = (folder) => {
  const release = dirname(folder);
  const plugins = dirname(release);
  const origin = dirname(plugins);
  const kept =
    basename(folder) === 'ref0' &&
    basename(release).startsWith('release-') &&
    basename(plugins) === 'plugins' &&
    basename(dirname(origin)) === 'origins';

  return kept ? join(origin, 'bin', 'ref0') : undefined;
};

// The Git folder ref0 keeps for this server's config folder, by its real path, as the service
// finds the folder from the server's variables and a session's start writes the agent's include
// there: none when it can't be named.
const configFolder = {"variable":"OPENCODE_CONFIG_DIR","inHome":".config/opencode","inConfigHome":"opencode"};
const gitFolderOf = (origin, env) => {
  const named = env[configFolder.variable] ?? '';
  const configHome = env.XDG_CONFIG_HOME ?? '';
  const folder =
    named !== ''
      ? named
      : configHome !== ''
        ? join(configHome, configFolder.inConfigHome)
        : join(env.HOME ?? '', configFolder.inHome);
  if (!isAbsolute(folder)) return undefined;

  try {
    const key = createHash('sha256').update(realpathSync(folder)).digest('hex');

    return join(origin, 'opencode', key.slice(0, 16));
  } catch {
    return undefined;
  }
};

// A word as Git's `GIT_CONFIG_PARAMETERS` quotes it.
const quoted = (word) => "'" + word.replaceAll("'", "'\\''") + "'";

const manifestOf = (folder) => {
  try {
    const read = JSON.parse(readFileSync(join(folder, 'ref0.json'), 'utf8'));

    return typeof read.version === 'string' && typeof read.protocol === 'string' ? read : undefined;
  } catch {
    return undefined;
  }
};

const bytes = (text) => Buffer.byteLength(text, 'utf8');

export default {
  id: 'ref0',
  setup: async (ctx) => {
    const folder = dirname(fileURLToPath(import.meta.url));
    const launcher = launcherOf(folder);
    const manifest = manifestOf(folder);
    if (launcher === undefined || manifest === undefined) return;

    const git = gitFolderOf(dirname(dirname(dirname(folder))), process.env);
    const environment = {
      ...process.env,
      REF0_PLUGIN_VERSION: manifest.version,
      REF0_SELECT_ORIGIN: '1',
    };

    // The launcher's answer to one hook, as JSON, or none: it runs in the session's folder.
    const run = (name, fields, cwd) =>
      new Promise((resolve) => {
        let out = '';
        let child;
        try {
          child = spawn('/bin/sh', [launcher, hooks.hook, name, '--protocol', manifest.protocol], {
            cwd,
            env: environment,
            stdio: ['pipe', 'pipe', 'ignore'],
          });
        } catch {
          return resolve(undefined);
        }
        const timer = setTimeout(() => child.kill('SIGKILL'), waitMs);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => (out += chunk));
        child.on('error', () => {
          clearTimeout(timer);
          resolve(undefined);
        });
        child.on('close', () => {
          clearTimeout(timer);
          try {
            resolve(out.trim() === '' ? undefined : JSON.parse(out));
          } catch {
            resolve(undefined);
          }
        });
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify(fields));
      });

    // Each session: its folder, its root, whether it's one, its turn and the text waiting for it.
    const sessions = new Map();
    // Each session's latest step's model, and the agent's shell calls whose shells haven't started,
    // by their tags.
    const models = new Map();
    const agentShells = new Map();
    // Each root's tally of its turn since its last `Stop`, and each step's, by its message.
    const tallies = new Map();
    const steps = new Map();
    // Each session's callbacks, in the order they came.
    const chains = new Map();

    const inOrder = (sessionID, work) => {
      const next = (chains.get(sessionID) ?? Promise.resolve()).then(work, work);
      const settled = next.catch(() => {});
      chains.set(sessionID, settled);

      return settled;
    };

    // `text` waiting for the session's next model call. Nothing is dropped: a hook sent while any
    // waits says so, and takes no more, so what's owed stays owed, unshown, until it went in.
    const queue = (session, answer) => {
      if (answer === undefined || typeof answer.context !== 'string' || answer.context === '')
        return;

      session.waiting.push({ text: answer.context, tell: answer.tell });
    };

    // Whether text an answer gave waits for its model call: a subagent's hooks count its root's,
    // whose session they carry.
    const waitingFor = (session) => (session.root ?? session).waiting.length > 0;

    const send = async (session, name, fields) =>
      queue(session, await run(name, waitingFor(session) ? { ...fields, waiting: 'yes' } : fields, session.directory));

    // The session as first seen: its parent's first, then its own start.
    const seen = new Map();
    const sessionOf = (sessionID) => {
      const known = seen.get(sessionID);
      if (known !== undefined) return known;

      const looking = (async () => {
        const info = await ctx.session.get({ sessionID });
        const parent = info.parentID === undefined ? undefined : await sessionOf(info.parentID);
        const session = {
          id: sessionID,
          directory: info.location?.directory ?? parent?.directory,
          parent,
          root: parent === undefined ? undefined : (parent.root ?? parent),
          turn: undefined,
          open: false,
          waiting: [],
        };
        sessions.set(sessionID, session);
        if (session.root === undefined) {
          await send(session, hooks.start, {
            sessionID,
            directory: session.directory,
            ...(info.fork === undefined ? {} : { forkSessionID: info.fork.sessionID }),
          });
        } else {
          await send(session, hooks.SubagentStart, {
            sessionID,
            parentID: parent.id,
            subagentID: sessionID,
            ...(session.root.turn === undefined ? {} : { messageID: session.root.turn }),
          });
        }

        return session;
      })();
      // A lookup that fails is tried again at the session's next callback.
      seen.set(sessionID, looking);
      looking.catch(() => seen.delete(sessionID));

      return looking;
    };

    // A callback of the session, in its order, once it's seen.
    const on = (sessionID, work) =>
      inOrder(sessionID, async () => {
        const session = await sessionOf(sessionID).catch(() => undefined);
        if (session !== undefined) await work(session);
      });

    const own = (session) =>
      session.root === undefined
        ? { sessionID: session.id, messageID: session.turn }
        : { sessionID: session.id, messageID: session.turn, subagentID: session.id };

    const tallyOf = (root) => {
      let tally = tallies.get(root.id);
      if (tally === undefined && root.turn !== undefined) {
        tally = { prompts: [], steps: new Map(), open: new Set(), whole: true, closed: false, settled: undefined };
        tallies.set(root.id, tally);
      }

      return tally;
    };

    // The tally once its open steps have ended, as OpenCode's events bring them after its idle:
    // queued events first, then a bounded wait. A step still open by then misses the turn.
    const settle = async (tally) => {
      await new Promise((done) => setTimeout(done, 0));
      if (tally.open.size > 0) {
        let timer;
        await new Promise((done) => {
          tally.settled = done;
          timer = setTimeout(done, settleMs);
        });
        clearTimeout(timer);
        tally.settled = undefined;
      }
      if (tally.open.size > 0) tally.whole = false;
    };

    await ctx.session.hook('prompt', (e) =>
      on(e.sessionID, async (session) => {
        if (!session.open) session.turn = e.messageID;
        session.open = true;
        if (session.root === undefined) {
          const tally = tallyOf(session);
          if (tally.prompts.length < mostPrompts) tally.prompts.push(e.messageID);
          else tally.whole = false;
        }
        await send(session, hooks.UserPromptSubmit, own(session));
      }),
    );

    const toolFields = (session, e) => {
      const keys = editInput[e.tool];
      const input =
        keys === undefined || typeof e.input !== 'object' || e.input === null
          ? undefined
          : Object.fromEntries(keys.filter((key) => key in e.input).map((key) => [key, e.input[key]]));

      return {
        ...own(session),
        directory: session.directory,
        tool: e.tool,
        id: e.id,
        ...(input === undefined ? {} : { input }),
      };
    };

    await ctx.tool.hook('execute.before', (e) => {
      // The tool gets a copy of the call's input, which the session doesn't keep, its command
      // tagged for this call alone.
      if (git !== undefined && e.tool === shellTool && typeof e.input?.command === 'string') {
        const tag = randomBytes(8).toString('hex');
        agentShells.set(tag, models.get(e.sessionID));
        if (agentShells.size > mostAgentShells) agentShells.delete(agentShells.keys().next().value);
        e.input = { ...e.input, command: e.input.command + '\n# ref0 shell ' + tag };
      }

      return on(e.sessionID, (session) => send(session, hooks.PreToolUse, toolFields(session, e)));
    });

    await ctx.tool.hook('execute.after', (e) => {
      // A call that started no shell, as one refused, leaves no tag.
      const tagged = typeof e.input?.command === 'string' ? shellTag.exec(e.input.command) : null;
      if (tagged !== null) agentShells.delete(tagged[1]);

      return on(e.sessionID, (session) =>
        send(
          session,
          e.status === 'error' ? hooks.PostToolUseFailure : hooks.PostToolUse,
          toolFields(session, e),
        ),
      );
    });

    await ctx.session.hook('experimental.idle', (e) =>
      on(e.sessionID, async (session) => {
        session.open = false;
        if (session.root !== undefined) return send(session, hooks.SubagentStop, own(session));

        const tally = tallies.get(session.id);
        if (tally !== undefined) await settle(tally);
        tallies.delete(session.id);
        if (tally !== undefined) tally.closed = true;
        const counted = [...(tally?.steps.values() ?? [])];
        const facts =
          tally === undefined
            ? undefined
            : {
                prompts: tally.prompts,
                steps: counted.slice(0, mostSteps),
                whole: tally.whole && counted.length <= mostSteps,
              };
        await send(session, hooks.Stop, { ...own(session), ...(facts === undefined ? {} : { facts }) });
      }),
    );

    // Waiting text in at the session's next model call, in order, as much as OpenCode's bound
    // takes, then told shown, each on its own: the rest waits for the call after.
    await ctx.session.hook('context', (e) => {
      const session = sessions.get(e.sessionID);
      if (session === undefined || session.waiting.length === 0) return;

      let used = 0;
      let count = 0;
      for (const one of session.waiting) {
        if (count > 0 && used + bytes(one.text) > textBytes) break;
        used += bytes(one.text);
        count += 1;
      }
      const told = session.waiting.splice(0, count);
      for (const one of told) e.system.push({ type: 'text', text: one.text });
      for (const one of told)
        if (typeof one.tell === 'string') void run(hooks.shown, { tell: one.tell }, session.directory);
    });

    const endTurn = (sessionID) => {
      const session = sessions.get(sessionID);
      if (session === undefined) return;

      session.open = false;
      if (session.root !== undefined) return;

      const tally = tallies.get(sessionID);
      if (tally !== undefined) tally.closed = true;
      tallies.delete(sessionID);
    };

    const watch = async () => {
      const types = [
        'session.created',
        'session.step.started',
        'session.step.ended',
        'session.step.failed',
        'session.execution.interrupted',
        'session.execution.failed',
        'session.deleted',
      ];
      for await (const event of ctx.event.subscribe({ types })) {
        const data = event.data ?? {};
        if (event.type === 'server.connected') {
          // Events may have been missed while the stream reconnected.
          for (const tally of tallies.values()) tally.whole = false;
        } else if (event.type === 'session.created') {
          void on(data.sessionID, async () => {});
        } else if (event.type === 'session.step.started') {
          models.set(data.sessionID, data.model.providerID + '/' + data.model.id);
          const session = sessions.get(data.sessionID);
          const root = session === undefined ? undefined : (session.root ?? session);
          const tally = root === undefined ? undefined : tallyOf(root);
          if (tally === undefined) continue;

          tally.open.add(data.assistantMessageID);
          steps.set(data.assistantMessageID, {
            tally,
            model: data.model.providerID + '/' + data.model.id,
            agent: session.root === undefined ? undefined : session.id,
          });
          if (steps.size > mostOpenSteps) steps.delete(steps.keys().next().value);
        } else if (event.type === 'session.step.ended' || event.type === 'session.step.failed') {
          const step = steps.get(data.assistantMessageID);
          const sessionNow = sessions.get(data.sessionID);
          const rootNow = sessionNow === undefined ? undefined : (sessionNow.root ?? sessionNow);
          if (step === undefined) {
            // Seen only ending: the turn open now misses it.
            const tally = rootNow === undefined ? undefined : tallies.get(rootNow.id);
            if (tally !== undefined) tally.whole = false;
            continue;
          }
          // Its turn's `Stop` came first: it counts nowhere.
          if (step.tally.closed) continue;

          step.tally.open.delete(data.assistantMessageID);
          if (step.tally.open.size === 0) step.tally.settled?.();

          const tokens = data.tokens;
          if (tokens === undefined) {
            step.tally.whole = false;
            continue;
          }
          step.tally.steps.set(data.assistantMessageID, {
            step: data.assistantMessageID,
            model: step.model,
            ...(step.agent === undefined ? {} : { agent: step.agent }),
            input: tokens.input,
            output: tokens.output,
            reasoning: tokens.reasoning,
            cacheRead: tokens.cache.read,
            cacheWrite: tokens.cache.write,
          });
        } else if (
          event.type === 'session.execution.interrupted' ||
          event.type === 'session.execution.failed'
        ) {
          endTurn(data.sessionID);
        } else if (event.type === 'session.deleted') {
          // Its waiting text is never shown, so never told.
          endTurn(data.sessionID);
          sessions.delete(data.sessionID);
          seen.delete(data.sessionID);
          chains.delete(data.sessionID);
          tallies.delete(data.sessionID);
          models.delete(data.sessionID);
        }
      }
    };
    void watch().catch(() => {});

    // A shell the agent's shell tool starts names the agent's include, which a session's start
    // writes, and the model its session's latest step named: OpenCode's hook for it names neither
    // session nor call, so the call tags its command, and the hook takes the tag out before the
    // shell runs. A shell the person starts, as OpenCode's shell mode does, has no call and gets
    // neither.
    if (git !== undefined) {
      const include = quoted('include.path=' + join(git, "agent.gitconfig"));
      await ctx.shell.hook('create.before', (e) => {
        const tagged = shellTag.exec(e.command);
        if (tagged === null) return;

        e.command = e.command.slice(0, tagged.index);
        // A call forgotten past the bound starts its shell as the person's.
        if (!agentShells.has(tagged[1])) return;

        const model = agentShells.get(tagged[1]);
        agentShells.delete(tagged[1]);
        const before = e.env.GIT_CONFIG_PARAMETERS ?? '';
        e.env.GIT_CONFIG_PARAMETERS = before === '' ? include : before + ' ' + include;
        e.env.REF0_HARNESS = "opencode";
        if (model === undefined) delete e.env.REF0_MODEL;
        else e.env.REF0_MODEL = model;
      });
    }
  },
};
