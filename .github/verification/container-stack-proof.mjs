#!/usr/bin/env node
// Verification helper, not application code. Run only on a disposable Linux
// environment meeting the unchanged launcher's real large-profile requirements.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execute = promisify(execFile);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const source = resolve(option("--source") ?? process.cwd());
const arch = option("--arch") ?? "amd64";
const prefix = option("--image-prefix") ?? "spaceapp-ci";
const reportFile = option("--report");
const command = async (binary, argv, options = {}) => (await execute(binary, argv, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 180_000, ...options })).stdout.trim();
const docker = argv => command("docker", argv);
async function until(check, description, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  let last;
  do {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await wait(1_000);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${description}`, { cause: last });
}

async function run() {
  assert.equal(process.platform, "linux", "This proof requires a real disposable Linux environment");
  assert(["amd64", "arm64"].includes(arch));
  const launcher = await import(pathToFileURL(join(source, "packages/run-spaceapp/src/index.mjs")));
  const { RUNTIME_VERSION } = await import(pathToFileURL(join(source, "packages/run-spaceapp/src/package-info.mjs")));
  const { pinnedServiceImage } = await import(pathToFileURL(join(source, "scripts/container-smoke.mjs")));
  const parent = await mkdtemp(join(tmpdir(), "spaceapp-large-proof-"));
  const home = join(parent, "state");
  const project = launcher.composeProjectName(home);
  const label = `com.docker.compose.project=${project}`;
  const createdTags = [];
  const secrets = new Set();
  let mayHaveCreatedResources = false;
  let failure;
  let terminalSocket;
  let installationOutput = "";
  const report = { environment: process.env.SPACEAPP_PROOF_ENVIRONMENT ?? "disposable Linux", sourceRevision: process.env.SOURCE_REVISION ?? null, profile: "large", resources: null, launcherVersion: RUNTIME_VERSION, install: false, workflowsReady: false, ownerSetup: false, openCodeRunning: false, openCodeVersion: null, terminalStdoutBytes: 0, browserReady: false, browserTitle: null, browserPngBytes: 0, cleaned: false };
  const redact = text => { for (const value of secrets) if (value) text = text.replaceAll(value, "[redacted synthetic secret]"); return text; };
  async function captureSecrets() {
    for (const name of ["setup-token", "session-secret", "database-url", "postgres-password"]) {
      try { secrets.add((await readFile(join(home, "secrets", name), "utf8")).trim()); } catch { /* Not yet created. */ }
    }
  }
  try {
    report.resources = await launcher.inspectSystemResources(home);
    const checks = launcher.installResourceChecks(report.resources, "large");
    assert(checks.every(check => check.ok), `Real resources fail large profile: ${JSON.stringify(checks)}`);
    assert.equal(await docker(["ps", "-aq", "--filter", `label=${label}`]), "", "Refuse a pre-existing Compose project");
    assert.equal(await docker(["volume", "ls", "-q", "--filter", `label=${label}`]), "", "Refuse pre-existing project data");
    for (const target of ["core", "browser", "cli"]) {
      const built = `${prefix}:${target}-${arch}`;
      const canonical = `ghcr.io/oll4com/spaceapp-${target}:${RUNTIME_VERSION}`;
      const builtId = await docker(["image", "inspect", "--format", "{{.Id}}", built]);
      let existingId;
      try { existingId = await docker(["image", "inspect", "--format", "{{.Id}}", canonical]); } catch { /* New local tag. */ }
      assert(!existingId || existingId === builtId, `Refuse overwriting an unrelated local image tag: ${canonical}`);
      if (!existingId) { await docker(["image", "tag", built, canonical]); createdTags.push(canonical); }
    }
    const compose = await readFile(join(source, "packages/run-spaceapp/templates/compose.yml"), "utf8");
    for (const service of ["postgres", "temporal"]) await docker(["pull", pinnedServiceImage(compose, service)]);
    const answers = JSON.stringify({ profile: "large", access: "isolated", companions: false, telemetry: false, open: false, confirm: true });
    mayHaveCreatedResources = true;
    const result = await execute(process.execPath, [join(source, "packages/run-spaceapp/bin/spaceapp.mjs"), "install", "--profile", "large", "--access", "isolated", "--no-open", "--local-images", "--non-interactive", "--answers", answers], { encoding: "utf8", timeout: 900_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, SPACEAPP_HOME: home, SPACEAPP_TELEMETRY: "false" } });
    installationOutput = `${result.stdout}\n${result.stderr}`;
    await captureSecrets();
    report.install = true;
    const config = await launcher.loadConfig(home);
    assert.equal(config.profile, "large");
    assert.equal(config.bindHost, "127.0.0.1");
    const base = `http://127.0.0.1:${config.port}`;
    const ready = await until(async () => {
      const response = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return null;
      const payload = await response.json();
      return payload.ok === true && payload.dependencies?.worker === "RUNNING" ? payload : null;
    }, "real workflow-enabled readiness");
    report.workflowsReady = ready.ok === true && ready.dependencies.worker === "RUNNING";
    const token = (await readFile(join(home, "secrets/setup-token"), "utf8")).trim();
    const password = randomBytes(24).toString("base64url");
    secrets.add(password);
    let cookie = "";
    let csrf;
    async function request(path, method = "GET", body) {
      const response = await fetch(`${base}${path}`, { method, signal: AbortSignal.timeout(90_000), headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(csrf && method !== "GET" ? { [csrf.headerName]: csrf.csrfToken } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const payload = await response.json();
      assert(response.ok, `API ${method} ${path} returned ${response.status}: ${redact(JSON.stringify(payload).slice(0, 1500))}`);
      const sessionCookie = response.headers.getSetCookie().find(value => value.startsWith("space_session="));
      if (sessionCookie) { cookie = sessionCookie.split(";", 1)[0]; secrets.add(cookie); }
      return payload;
    }
    const owner = await request("/api/setup/claim", "POST", { token, email: "container-ci@example.invalid", password });
    assert(owner.isAuthenticated && owner.starterRoomId);
    assert(cookie);
    report.ownerSetup = true;
    csrf = await request("/api/auth/csrf");
    secrets.add(csrf.csrfToken);
    const starter = await request("/api/setup/starter-room", "POST");
    assert.equal(starter.room.name, "Getting Started");
    const panes = await request(`/api/panes?roomId=${encodeURIComponent(owner.starterRoomId)}`);
    const pane = panes.data.find(pane => pane.terminalRuntimeId === "cli:opencode");
    assert(pane, "Getting Started OpenCode pane is missing");
    const cliPath = `/api/panes/${encodeURIComponent(pane.id)}/cli/session`;
    const allocated = await request(cliPath, "POST", { runtimeId: "cli:opencode", includeTranscript: true });
    assert(allocated.websocket?.token && allocated.session?.sessionId);
    secrets.add(allocated.websocket.token);
    // Allocation is intentionally IDLE. Follow the actual UI's protocol-v2
    // terminal attach to start the real PTY, rather than polling an idle session.
    const WebSocket = createRequire(import.meta.url)(join(source, "node_modules/ws"));
    const terminalUrl = new URL(`/api/panes/${encodeURIComponent(pane.id)}/cli/terminal`, base.replace(/^http/, "ws"));
    const terminalQuery = { sessionId: allocated.session.sessionId, token: allocated.websocket.token,
      protocolVersion: "2", browserClientId: randomUUID(), tabLineageId: randomUUID(), pageClientId: randomUUID(),
      clientMode: "INTERACTIVE", initialCols: "120", initialRows: "36" };
    for (const [key, value] of Object.entries(terminalQuery)) terminalUrl.searchParams.set(key, value);
    report.cliAttach = { protocolVersion: 2, ready: false, stdoutBytes: 0, status: null, error: null };
    terminalSocket = new WebSocket(terminalUrl, { headers: { cookie, origin: base } });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error("Timed out waiting for real terminal attach and OpenCode output")), 180_000);
      function finish(error) { clearTimeout(timeout); error ? reject(error) : resolve(); }
      terminalSocket.on("message", raw => {
        try {
          const message = JSON.parse(String(raw));
          if (message.type === "error") throw new Error(`Terminal ${message.code}: ${message.message}`);
          if (message.type === "ready") {
            assert.equal(message.sessionId, allocated.session.sessionId);
            assert.equal(message.runtimeId, "cli:opencode");
            report.cliAttach.ready = true;
          }
          if (message.type === "status") report.cliAttach.status = message.status;
          if (message.type === "output" && message.stream === "stdout") report.cliAttach.stdoutBytes += Buffer.byteLength(message.data);
          if (report.cliAttach.ready && report.cliAttach.stdoutBytes > 100) finish();
        } catch (error) { report.cliAttach.error = redact(error.message); finish(error); }
      });
      terminalSocket.on("error", error => { report.cliAttach.error = redact(error.message); finish(error); });
      terminalSocket.on("close", code => { finish(new Error(`Terminal closed before proof completion (${code})`)); });
    });
    await wait(3_000);
    const cli = await until(async () => {
      const value = await request(`${cliPath}?includeTranscript=true`);
      if (!value || value.session.status !== "RUNNING") return null;
      const stdoutBytes = value.transcript.filter(chunk => chunk.stream === "stdout").reduce((total, chunk) => total + Buffer.byteLength(chunk.content), 0);
      return stdoutBytes > 100 ? { value, stdoutBytes } : null;
    }, "live OpenCode UI output");
    assert.equal(cli.value.session.runtimeId, "cli:opencode");
    report.openCodeRunning = true;
    report.terminalStdoutBytes = cli.stdoutBytes;
    const cliContainer = await docker(["ps", "-q", "--filter", `label=${label}`, "--filter", "label=com.docker.compose.service=spaceapp-cli"]);
    assert.match(cliContainer, /^[a-f0-9]+$/);
    report.openCodeVersion = await docker(["exec", "--user", "10001:10001", cliContainer, "/usr/local/bin/opencode", "--version"]);
    assert.equal(report.openCodeVersion, "opencode v2.0.32");
    const browserPane = await request("/api/panes", "POST", { roomId: owner.starterRoomId, title: "Container browser proof", mode: "BROWSER" });
    assert(browserPane.id);
    const browserPath = `/api/panes/${encodeURIComponent(browserPane.id)}/browser/session`;
    await request(browserPath, "POST", { targetUrl: "https://example.com/", includeInitialFrame: true });
    const browser = await until(async () => {
      const value = await request(browserPath);
      return value.session.status === "READY" && value.session.isActive && /Example Domain/i.test(value.session.title ?? "") && value.frame?.screenshotDataUrl ? value : null;
    }, "real browser pane navigation and rendered frame");
    assert.equal(new URL(browser.session.currentUrl).hostname, "example.com");
    const png = Buffer.from(browser.frame.screenshotDataUrl.split(",", 2)[1], "base64");
    assert(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && png.length > 1024);
    report.browserReady = true;
    report.browserTitle = browser.session.title;
    report.browserPngBytes = png.length;
    assert.equal((await request(`${cliPath}?includeTranscript=false`)).session.status, "RUNNING",
      "OpenCode must still be running after the browser page opens");
  } catch (error) {
    failure = error;
    report.failure = redact(error.message).slice(0, 1500);
    installationOutput ||= `${error.stdout ?? ""}\n${error.stderr ?? ""}`;
    await captureSecrets();
  } finally {
    if (terminalSocket) {
      terminalSocket.close();
      await Promise.race([new Promise(resolve => terminalSocket.once("close", resolve)), wait(2_000)]);
      if (terminalSocket.readyState !== 3) terminalSocket.terminate();
    }
    if (mayHaveCreatedResources) {
      try {
        const spec = launcher.composeCommand("down", home, { profile: "large" });
        await command(spec.command, [...spec.args, "--volumes", "--remove-orphans"]);
      } catch (error) { failure ??= error; }
      for (const [kind, listArgs, removeArgs] of [
        ["containers", ["ps", "-aq", "--filter", `label=${label}`], ["rm", "--force", "--volumes"]],
        ["volumes", ["volume", "ls", "-q", "--filter", `label=${label}`], ["volume", "rm"]],
        ["networks", ["network", "ls", "-q", "--filter", `label=${label}`], ["network", "rm"]]
      ]) {
        const remaining = (await docker(listArgs)).split(/\s+/).filter(Boolean);
        if (remaining.length) {
          try { await docker([...removeArgs, ...remaining]); } catch (error) { failure ??= error; }
          failure ??= new Error(`Normal Compose cleanup left ${kind}; fallback cleanup was required`);
        }
        if (await docker(listArgs)) failure ??= new Error(`Owned ${kind} remain after cleanup`);
      }
    }
    for (const tag of createdTags) { try { await docker(["image", "rm", tag]); } catch (error) { failure ??= error; } }
    if (dirname(parent) !== resolve(tmpdir()) || !parent.startsWith(join(resolve(tmpdir()), "spaceapp-large-proof-"))) throw new Error("Unexpected proof state directory; refusing cleanup");
    await rm(parent, { recursive: true, force: true });
    report.cleaned = !failure;
    if (installationOutput) process.stdout.write(`${redact(installationOutput)}\n`);
  }
  if (reportFile) await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (failure) throw new Error(redact(failure.message));
  assert(report.install && report.workflowsReady && report.ownerSetup && report.openCodeRunning && report.browserReady && report.cleaned);
}

run().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
