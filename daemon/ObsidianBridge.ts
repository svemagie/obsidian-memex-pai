// ~/.claude/PAI/Tools/ObsidianBridge.ts
import { readdir, readFile } from "fs/promises";
import { join } from "path";

if (!process.env.HOME) throw new Error("HOME environment variable is not set");

const VERSION = "0.1.0";
const PAI_PATH = `${process.env.HOME}/.claude`;
const PORT = 8765;

// Skill roots: personal skills first, then superpowers marketplace
const PERSONAL_SKILLS_PATH = `${PAI_PATH}/skills`;
const SUPERPOWERS_SKILLS_PATH = `${PAI_PATH}/plugins/marketplaces/superpowers-dev/skills`;
const ALGORITHM_PATH = `${PAI_PATH}/PAI/Algorithm`;

/** Extract description from a SKILL.md string */
function extractDescription(content: string, fallback: string): string {
  let bodyStart = 0;
  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---\n", 4);
    if (end !== -1) {
      const frontmatter = content.slice(4, end);
      const descMatch = frontmatter.match(/^description:\s*(?:"([^"]+)"|'([^']+)'|(.+?))\s*$/m);
      if (descMatch) {
        const desc = (descMatch[1] ?? descMatch[2] ?? descMatch[3] ?? "").trim();
        if (desc.length > 0) return desc;
      }
      bodyStart = end + 5;
    }
  }
  const body = content.slice(bodyStart);
  const firstLine = body.split("\n").find(l => l.trim() && !l.trim().startsWith("#") && l.trim() !== "---");
  return firstLine?.trim() ?? fallback;
}

/** Recursively find all SKILL.md files under a root, returning relative paths (without /SKILL.md) */
async function findSkillDirs(root: string, rel = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(root, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const results: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    // Check if this dir has a SKILL.md
    try {
      await readFile(join(root, childRel, "SKILL.md"), "utf8");
      results.push(childRel);
    } catch { /* no SKILL.md — recurse into children */ }
    results.push(...await findSkillDirs(root, childRel));
  }
  return results;
}

async function buildPrompt(action: string, skill: string | undefined, content: string): Promise<string> {
  let systemPrompt: string;

  if (action === "skill" && skill) {
    // Try personal skills first, then superpowers
    let skillFile = join(PERSONAL_SKILLS_PATH, skill, "SKILL.md");
    try {
      systemPrompt = await readFile(skillFile, "utf8");
    } catch {
      skillFile = join(SUPERPOWERS_SKILLS_PATH, skill, "SKILL.md");
      systemPrompt = await readFile(skillFile, "utf8");
    }
  } else {
    const latest = (await readFile(join(ALGORITHM_PATH, "LATEST"), "utf8")).trim();
    systemPrompt = await readFile(join(ALGORITHM_PATH, `${latest}.md`), "utf8");
  }

  return `${systemPrompt}\n\n---\n\nNote content:\n\n${content}`;
}

function sseChunk(data: object): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

async function getSkills(): Promise<Array<{ name: string; description: string }>> {
  const [personalDirs, superpowersDirs] = await Promise.all([
    findSkillDirs(PERSONAL_SKILLS_PATH),
    findSkillDirs(SUPERPOWERS_SKILLS_PATH),
  ]);

  const toEntry = (root: string) => async (relPath: string) => {
    let description = relPath.split("/").pop() ?? relPath;
    try {
      const content = await readFile(join(root, relPath, "SKILL.md"), "utf8");
      description = extractDescription(content, description);
    } catch { /* fallback */ }
    return { name: relPath, description };
  };

  const [personal, superpowers] = await Promise.all([
    Promise.all(personalDirs.map(toEntry(PERSONAL_SKILLS_PATH))),
    Promise.all(superpowersDirs.map(toEntry(SUPERPOWERS_SKILLS_PATH))),
  ]);

  return [...personal, ...superpowers];
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const server = Bun.serve({
  port: PORT,
  idleTimeout: 0, // disable — claude --print can take minutes
  async fetch(req) {
    const url = new URL(req.url);

    // Preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (req.method === "GET" && url.pathname === "/status") {
      return Response.json({ version: VERSION, paiPath: PAI_PATH }, { headers: CORS_HEADERS });
    }

    if (req.method === "GET" && url.pathname === "/skills") {
      try {
        const skills = await getSkills();
        return Response.json(skills, { headers: CORS_HEADERS });
      } catch {
        return new Response("Internal Server Error", { status: 500, headers: CORS_HEADERS });
      }
    }

    if (req.method === "POST" && url.pathname === "/invoke") {
      let body: { action: string; skill?: string; content: string; notePath: string };
      try {
        body = await req.json() as typeof body;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400, headers: CORS_HEADERS });
      }

      // Validate required fields
      if (typeof body.action !== "string" || typeof body.content !== "string" || typeof body.notePath !== "string") {
        return Response.json({ error: "missing required fields" }, { status: 400, headers: CORS_HEADERS });
      }
      if (body.action === "skill" && typeof body.skill !== "string") {
        return Response.json({ error: "skill name required for action=skill" }, { status: 400, headers: CORS_HEADERS });
      }

      // Size guard
      if (body.content.length > 100 * 1024) {
        return Response.json({ error: "content too large" }, { status: 413, headers: CORS_HEADERS });
      }

      const basename = body.notePath.split("/").pop()?.replace(/\.md$/, "") ?? "Note";
      const skillName = body.skill ?? "Algorithm";
      const suggestedName = body.action === "skill"
        ? `${basename} - ${skillName}.md`
        : undefined;

      const stream = new ReadableStream({
        async start(controller) {
          const enqueue = (data: object) =>
            controller.enqueue(new TextEncoder().encode(sseChunk(data)));

          let prompt: string;
          try {
            prompt = await buildPrompt(body.action, body.skill, body.content);
          } catch (e) {
            enqueue({ type: "done", error: `Failed to build prompt: ${(e as Error).message}` });
            controller.close();
            return;
          }

          // Pass prompt via stdin to avoid ARG_MAX limits on large prompts
          const proc = Bun.spawn(["claude", "--print"], {
            stdin: new Blob([prompt]),
            stdout: "pipe",
            stderr: "pipe",
          });

          // Drain stderr concurrently; capture promise so we can await it after exit
          const stderrPromise = (async () => {
            const errReader = proc.stderr.getReader();
            const dec = new TextDecoder();
            let text = "";
            while (true) {
              const { done, value } = await errReader.read();
              if (done) break;
              text += dec.decode(value);
            }
            return text;
          })();

          const reader = proc.stdout.getReader();
          const decoder = new TextDecoder();

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            enqueue({ type: "chunk", text: decoder.decode(value, { stream: true }) });
          }
          enqueue({ type: "chunk", text: decoder.decode() }); // flush final bytes

          const [exitCode, stderrText] = await Promise.all([proc.exited, stderrPromise]);
          if (exitCode !== 0) {
            enqueue({ type: "done", error: `claude exited with code ${exitCode}: ${stderrText.trim()}` });
          } else {
            const doneEvent: Record<string, string> = {
              type: "done",
              resultAction: body.action === "skill" ? "new-note" : "append",
            };
            if (suggestedName) doneEvent.suggestedName = suggestedName;
            enqueue(doneEvent);
          }

          controller.close();
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          ...CORS_HEADERS,
        },
      });
    }

    return new Response("Not Found", { status: 404, headers: CORS_HEADERS });
  },
});

console.log(`PAI ObsidianBridge v${VERSION} listening on :${PORT}`);
