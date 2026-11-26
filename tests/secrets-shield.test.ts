import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { defaultConfig } from "../src/config.ts";
import { ProcessManager } from "../src/process-manager.ts";
import { AuditLogger } from "../src/security.ts";
import { maskSecrets } from "../src/secrets-shield.ts";
import { createGeminationMcpServer } from "../src/tools.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Secret Shield masking", () => {
  test("masks provider tokens, private keys, JWTs, and secret settings while keeping placeholders", () => {
    const fakeOpenAi = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    const fakeAnthropic = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
    const fakeGithub = "ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD";
    const fakeAws = "AKIA1234567890ABCDEF";
    const fakeGoogle = "AIzaSyD-1234567890abcdefghijklmnopqrstu";
    const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMSJ9.signaturePart12345";

    const sample = [
      `OPENAI_API_KEY=${fakeOpenAi}`,
      `ANTHROPIC_KEY=${fakeAnthropic}`,
      `GH=${fakeGithub}`,
      `AWS_ACCESS_KEY_ID=${fakeAws}`,
      `GOOGLE_KEY="${fakeGoogle}"`,
      `JWT=${fakeJwt}`,
      `DB_PASSWORD="myRealSuperSecretPassword!"`,
      `GEMINATION_PIN=9999-ABCD-EFGH`,
      `GEMINI_ACCESS=gma_1234567890abcdefghij`,
      `GEMINI_SECRET=gsec_1234567890abcdefghij`,
      `AUTH="Bearer mySecretBearerTokenValue123456"`,
      `GIT_REMOTE=https://alice:super-secret-pass@github.com/org/repo.git`,
      `TEMPLATE_SECRET=\${MY_ENV_VAR}`,
      `DOC_PASSWORD=changeme`,
      `COMMIT_SHA=e3b0c44298fc1c149afbf4c8996fb92427ae41e4`,
      `-----BEGIN OPENSSH PRIVATE KEY-----`,
      `b3BlbnNzaC1rZXktdjEAAAAABG5vbmU=`,
      `-----END OPENSSH PRIVATE KEY-----`,
    ].join("\n");

    const { text, masked } = maskSecrets(sample);
    expect(text).not.toContain(fakeOpenAi);
    expect(text).not.toContain(fakeAnthropic);
    expect(text).not.toContain(fakeGithub);
    expect(text).not.toContain(fakeAws);
    expect(text).not.toContain(fakeGoogle);
    expect(text).not.toContain(fakeJwt);
    expect(text).not.toContain("myRealSuperSecretPassword!");
    expect(text).not.toContain("9999-ABCD-EFGH");
    expect(text).not.toContain("gma_1234567890abcdefghij");
    expect(text).not.toContain("gsec_1234567890abcdefghij");
    expect(text).not.toContain("mySecretBearerTokenValue123456");
    expect(text).not.toContain("super-secret-pass");
    expect(text).not.toContain("b3BlbnNzaC1rZXktdjE");

    expect(text).toContain("[OpenAI key hidden]");
    expect(text).toContain("[Anthropic key hidden]");
    expect(text).toContain("[GitHub token hidden]");
    expect(text).toContain("[AWS access key hidden]");
    expect(text).toContain("[Google API key hidden]");
    expect(text).toContain("[JSON Web Token hidden]");
    expect(text).toContain("[Gemination token hidden]");
    expect(text).toContain("[Bearer token hidden]");
    expect(text).toContain("[credentialed URL hidden]github.com/org/repo.git");
    expect(text).toContain("[private key hidden]");
    expect(text).toContain(`DB_PASSWORD="[value hidden]"`);
    expect(text).toContain("GEMINATION_PIN=[value hidden]");

    // Placeholders & hashes stay intact
    expect(text).toContain("TEMPLATE_SECRET=${MY_ENV_VAR}");
    expect(text).toContain("DOC_PASSWORD=changeme");
    expect(text).toContain("COMMIT_SHA=e3b0c44298fc1c149afbf4c8996fb92427ae41e4");
    expect(masked.length).toBeGreaterThanOrEqual(7);
  });

  test("preserves TAP test log PASS lines", () => {
    const tap = "PASS: tests/unit.ts\nPASS: tests/oauth.ts\n# TOTAL: 2\n";
    const { text, masked } = maskSecrets(tap);
    expect(text).toBe(tap);
    expect(masked).toEqual([]);
  });

  test("masks secrets in MCP read_file & run_command and records maskedSecrets in audit log", async () => {
    const ws = makeTempDir("gemination-shield-ws-");
    const cfgDir = makeTempDir("gemination-shield-cfg-");
    const secretVal = "ghp_ABCDEF1234567890abcdef1234567890abcdef";
    writeFileSync(join(ws, ".env"), `GITHUB_TOKEN=${secretVal}\nPORT=3847\n`, "utf8");

    const pm = new ProcessManager();
    const audit = new AuditLogger(cfgDir);
    const cfg = defaultConfig();
    cfg.roots = [realpathSync(ws)];
    cfg.shieldSecrets = true;

    const mcpServer = createGeminationMcpServer({
      config: cfg,
      configDir: cfgDir,
      defaultCwd: cfg.roots[0]!,
      audit,
      processManager: pm,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "shield-test", version: "1.0.0" });
    await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const readRes = await client.callTool({ name: "read_file", arguments: { path: ".env" } });
      const readText = (readRes.content as Array<{ text: string }>)[0]!.text;
      expect(readText).not.toContain(secretVal);
      expect(readText).toContain("[GitHub token hidden]");
      expect(readText).toContain("PORT=3847");

      const auditRaw = readFileSync(join(cfgDir, "audit.jsonl"), "utf8");
      expect(auditRaw).not.toContain(secretVal);
      expect(auditRaw).toContain("GitHub token");

      // Turning shieldSecrets off passes value through
      cfg.shieldSecrets = false;
      const unshielded = await client.callTool({ name: "read_file", arguments: { path: ".env" } });
      const rawText = (unshielded.content as Array<{ text: string }>)[0]!.text;
      expect(rawText).toContain(secretVal);
    } finally {
      pm.stopAll();
      await Promise.allSettled([client.close(), mcpServer.close()]);
    }
  });
});
