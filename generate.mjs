import https from "https";
import fs from "fs";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("❌ No API key");
  process.exit(1);
}

const TIME_ZONE = "America/Denver";
const MAX_ATTEMPTS = 20;

function getLocalParts(date, timeZone = TIME_ZONE) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "long",
  });

  const parts = formatter.formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return map;
}

function getLocalDateString(date, timeZone = TIME_ZONE) {
  const parts = getLocalParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function getPuzzleId(now, launchDateString) {
  const nowLocal = getLocalDateString(now);
  const msPerDay = 24 * 60 * 60 * 1000;
  const diffDays = Math.floor((Date.parse(`${nowLocal}T00:00:00Z`) - Date.parse(`${launchDateString}T00:00:00Z`)) / msPerDay);
  return diffDays + 1;
}

function normalizeAnswer(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ");
}

function parsePuzzleJson(raw) {
  return JSON.parse(String(raw).replace(/```json|```/g, "").trim());
}

function validatePuzzleShape(puzzle) {
  if (!puzzle || typeof puzzle !== "object") {
    throw new Error("Puzzle is not a JSON object");
  }

  if (typeof puzzle.answer !== "string" || !puzzle.answer.trim()) {
    throw new Error("Puzzle is missing a valid answer");
  }

  const answer = puzzle.answer.trim();
  if (!/^[A-Za-z][A-Za-z-]*$/.test(answer) || answer.includes(" ")) {
    throw new Error(`Answer must be a single word: ${answer}`);
  }

  if (!Array.isArray(puzzle.sentences) || puzzle.sentences.length !== 5) {
    throw new Error("Puzzle must contain exactly 5 sentences");
  }

  if (!Array.isArray(puzzle.close) || puzzle.close.length < 3 || puzzle.close.length > 5) {
    throw new Error("Puzzle close array must contain 3 to 5 words");
  }
}

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content: prompt }],
    });

    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed.content[0].text.trim());
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

let archive = [];
try {
  archive = JSON.parse(fs.readFileSync("puzzles.json", "utf8"));
} catch {
  archive = [];
}

const usedAnswers = new Set(
  archive
    .map((puzzle) => normalizeAnswer(puzzle.answer))
    .filter(Boolean)
);

// Puzzle number: days since launch (March 6, 2026 in Denver time)
const LAUNCH_DATE = "2026-03-06";

// Allow overrides: node generate.mjs --id=5 --date=2026-03-10
const idArg = process.argv.find((arg) => arg.startsWith("--id="));
const dateArg = process.argv.find((arg) => arg.startsWith("--date="));

const NOW = dateArg ? new Date(`${dateArg.split("=")[1]}T12:00:00Z`) : new Date();
const localParts = getLocalParts(NOW);
const TODAY_ISO = `${localParts.year}-${localParts.month}-${localParts.day}`;
const TODAY = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: TIME_ZONE,
}).format(NOW);

const PUZZLE_ID = idArg
  ? parseInt(idArg.split("=")[1], 10)
  : getPuzzleId(NOW, LAUNCH_DATE);

// Day of week in Denver (0 = Sunday, 1 = Monday ... 6 = Saturday)
const DOW = new Date(`${TODAY_ISO}T00:00:00Z`).getUTCDay();

// Difficulty ramp: Mon=easy, Tue=easy, Wed=medium, Thu=medium, Fri=hard, Sat=hard, Sun=wildcard
const DIFFICULTY_MAP = {
  0: { label: "WILDCARD", level: "wildcard" },
  1: { label: "EASY", level: "easy" },
  2: { label: "EASY", level: "easy" },
  3: { label: "MEDIUM", level: "medium" },
  4: { label: "MEDIUM", level: "medium" },
  5: { label: "HARD", level: "hard" },
  6: { label: "HARD", level: "hard" },
};

const DIFFICULTY = DIFFICULTY_MAP[DOW];

const DIFFICULTY_INSTRUCTIONS = {
  easy: `
DIFFICULTY: EASY
- The answer word should be concrete and universally familiar but not instantly obvious
- Examples of appropriate answer words: sleep, laughter, hunger, embarrassment, boredom, jealousy, curiosity
- The paragraph clues should be warm and accessible — someone should get it in 2-3 guesses
- Sentence 1 can be poetic but should not be impenetrable
- Avoid obscure vocabulary in the clues
- The word should be familiar but require a moment of thought`,

  medium: `
DIFFICULTY: MEDIUM
- The answer word should be familiar but more conceptual or abstract
- Examples: nostalgia, ambition, coincidence, forgiveness, procrastination, momentum, compromise, reputation
- A thoughtful person should get it in 3-4 guesses
- Sentence 1 should be indirect and sentence 4 should make it fairly clear
- The word should be something most adults use regularly but wouldn't guess immediately`,

  hard: `
DIFFICULTY: HARD
- The answer word should be abstract or nuanced but still something an educated person would know
- Examples: schadenfreude, catharsis, paradox, cognitive dissonance, entropy, inertia, zeitgeist, empathy, resilience
- Most players will need 4-5 clues to get it
- Sentence 1 should be cryptic but not impossible
- Avoid highly obscure academic terms from philosophy or linguistics that most people have never heard of
- The word should be something you might read in a quality newspaper`,

  wildcard: `
DIFFICULTY: WILDCARD (Sunday)
- Surprise us. Pick any difficulty level you want — could be easy, could be hard
- The topic should be unexpected and unlike anything from a typical weekday
- Consider unusual domains: architecture, cooking, mathematics, music theory, geology, linguistics
- Make it memorable and fun`,
};

const allUsedAnswers = Array.from(usedAnswers).sort();
const usedAnswersBlock = allUsedAnswers.length
  ? `\nDo NOT use any of these answers. They have already been used in prior GIST puzzles:\n${allUsedAnswers.join(", ")}\n`
  : "";

function buildPrompt({ rejectedAnswers = [] } = {}) {
  const rejectedBlock = rejectedAnswers.length
    ? `\nPreviously rejected answers in this run (do NOT use any of them again):\n${rejectedAnswers.join(", ")}\n`
    : "";

  return `Today is ${TODAY}. You are generating puzzle #${PUZZLE_ID} for GIST, a daily word game.

In GIST, a paragraph is revealed one sentence at a time. Players guess the ONE WORD that captures its essence. Each wrong guess reveals one more sentence of the paragraph as a clue. There are 5 sentences total, revealed one by one.

${DIFFICULTY_INSTRUCTIONS[DIFFICULTY.level]}
${usedAnswersBlock}${rejectedBlock}
Your job: create a puzzle. Choose a concept, emotion, phenomenon, idea, or everyday object as the answer word. Write a 5-sentence paragraph that describes it without ever saying the word. The paragraph should be beautifully written — like an encyclopedia crossed with a prose poem.

Rules:
- The answer must be a single English word (not a proper noun, not a phrase)
- The answer must be different from every prior GIST answer listed above
- The paragraph must NOT contain the answer word or obvious synonyms
- Sentence 1 should be the hardest clue (most abstract/indirect)
- Sentence 5 should be the most revealing
- The paragraph should feel like elegant, precise writing — not a riddle
- Also provide 3-5 "close" words that are near-synonyms (a player guessing these gets a yellow result)
- The "close" array MUST include common variations of the answer word (verb forms, plural, adjective forms, past tense, etc.) — for example if the answer is "anticipation" include "anticipate", "anticipating", "anticipated"

Return ONLY valid JSON, no markdown, exactly this format:
{
  "answer": "loneliness",
  "difficulty": "EASY",
  "sentences": [
    "It can exist in the middle of a crowd, invisible to everyone including the person experiencing it.",
    "Philosophers have argued it is the fundamental condition of consciousness — the irreducible gap between any two minds.",
    "Children rarely feel it; the capacity seems to develop alongside self-awareness.",
    "It is distinct from solitude, which is chosen, and from isolation, which is imposed.",
    "The word comes from 'lone' — the state of being the only one of its kind in a particular place."
  ],
  "close": ["isolation", "solitude", "alienation", "emptiness"]
}

Set "difficulty" in the JSON to exactly: "${DIFFICULTY.label}"`;
}

console.log(`🧩 Generating GIST puzzle #${PUZZLE_ID} [${DIFFICULTY.label} — ${TODAY} / ${TIME_ZONE}]...`);

let puzzle;
const rejectedAnswers = [];

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
  try {
    console.log(`🔁 Attempt ${attempt}/${MAX_ATTEMPTS}`);
    const raw = await callClaude(buildPrompt({ rejectedAnswers }));
    const candidate = parsePuzzleJson(raw);
    validatePuzzleShape(candidate);

    const normalized = normalizeAnswer(candidate.answer);
    if (!normalized) {
      throw new Error("Answer normalized to an empty value");
    }

    if (usedAnswers.has(normalized)) {
      throw new Error(`Duplicate historical answer: ${candidate.answer}`);
    }

    if (rejectedAnswers.includes(normalized)) {
      throw new Error(`Duplicate answer within retry loop: ${candidate.answer}`);
    }

    puzzle = candidate;
    break;
  } catch (error) {
    const duplicateMatch = String(error.message || "").match(/Duplicate (?:historical answer|answer within retry loop):\s*(.+)$/);
    if (duplicateMatch) {
      const rejected = normalizeAnswer(duplicateMatch[1]);
      if (rejected && !rejectedAnswers.includes(rejected)) rejectedAnswers.push(rejected);
    }

    if (error.message?.startsWith("Answer must be a single word:")) {
      const invalid = normalizeAnswer(error.message.replace("Answer must be a single word:", ""));
      if (invalid && !rejectedAnswers.includes(invalid)) rejectedAnswers.push(invalid);
    }

    console.warn(`⚠️ Attempt ${attempt} failed: ${error.message}`);
    if (attempt === MAX_ATTEMPTS) {
      console.error(`❌ Failed to generate a unique puzzle after ${MAX_ATTEMPTS} attempts.`);
      process.exit(1);
    }
  }
}

puzzle.id = PUZZLE_ID;
puzzle.difficulty = DIFFICULTY.label;
console.log(`✅ Answer: "${puzzle.answer}" [${puzzle.difficulty}]`);
console.log(`📝 Sentences: ${puzzle.sentences.length}`);

// Read template and inject puzzle data
const template = fs.readFileSync("template.html", "utf8");
const output = template.replace("__PUZZLE_DATA__", JSON.stringify(puzzle));

fs.writeFileSync("index.html", output);
console.log(`📄 index.html written for puzzle #${PUZZLE_ID}`);

// Update or insert
const existingIdx = archive.findIndex((entry) => entry.id === puzzle.id);
if (existingIdx >= 0) {
  archive[existingIdx] = puzzle;
} else {
  archive.push(puzzle);
}

// Sort descending by id
archive.sort((a, b) => b.id - a.id);
fs.writeFileSync("puzzles.json", JSON.stringify(archive, null, 2));
console.log(`📚 puzzles.json updated (${archive.length} puzzles total)`);
