import https from "https";
import fs from "fs";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("❌ No API key");
  process.exit(1);
}

const TIME_ZONE = "America/Denver";
const MAX_ATTEMPTS = 20;
const MIN_CLOSE_WORDS = 3;
const MAX_CLOSE_WORDS = 10;
const ALLOWED_PARTS_OF_SPEECH = new Set([
  "Noun (singular)",
  "Noun (plural)",
  "Verb",
  "Verb (infinitive)",
  "Verb (present participle)",
  "Verb (past participle)",
  "Adjective",
  "Adverb",
]);

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
  const cleaned = String(raw)
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (originalError) {
    const start = cleaned.indexOf("{");
    if (start < 0) throw originalError;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < cleaned.length; i += 1) {
      const char = cleaned[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          const jsonText = cleaned.slice(start, i + 1);
          const extraText = `${cleaned.slice(0, start)} ${cleaned.slice(i + 1)}`.trim();
          if (extraText) {
            const preview = extraText.replace(/\s+/g, " ").slice(0, 200);
            console.warn(`⚠️ Ignored extra model text around JSON: "${preview}"`);
          }
          return JSON.parse(jsonText);
        }
      }
    }

    throw originalError;
  }
}

function sanitizePuzzle(puzzle) {
  if (!puzzle || typeof puzzle !== "object" || !Array.isArray(puzzle.close)) {
    return puzzle;
  }

  const receivedCloseCount = puzzle.close.length;
  const seen = new Set();
  const close = [];

  for (const value of puzzle.close) {
    if (typeof value !== "string") continue;

    const word = value.trim();
    const normalized = normalizeAnswer(word);
    if (!normalized || seen.has(normalized)) continue;

    seen.add(normalized);
    close.push(word);

    if (close.length === MAX_CLOSE_WORDS) break;
  }

  if (receivedCloseCount !== close.length || receivedCloseCount < MIN_CLOSE_WORDS || receivedCloseCount > MAX_CLOSE_WORDS) {
    console.warn(`⚠️ Close words received: ${receivedCloseCount}; kept after cleanup: ${close.length}`);
  }

  return { ...puzzle, close };
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

  if (typeof puzzle.partOfSpeech !== "string" || !ALLOWED_PARTS_OF_SPEECH.has(puzzle.partOfSpeech)) {
    throw new Error(`Puzzle partOfSpeech must be one of: ${Array.from(ALLOWED_PARTS_OF_SPEECH).join(", ")}`);
  }

  if (!Array.isArray(puzzle.sentences) || puzzle.sentences.length !== 5) {
    throw new Error("Puzzle must contain exactly 5 sentences");
  }

  if (!Array.isArray(puzzle.close) || puzzle.close.length < MIN_CLOSE_WORDS || puzzle.close.length > MAX_CLOSE_WORDS) {
    throw new Error(`Puzzle close array must contain ${MIN_CLOSE_WORDS} to ${MAX_CLOSE_WORDS} words (received ${Array.isArray(puzzle.close) ? puzzle.close.length : "non-array"})`);
  }
}

function callClaude(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: "claude-sonnet-4-6",
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
- Choose an ordinary word almost everyone knows and uses in everyday conversation; a common feeling, action, object, or experience is ideal
- Examples of the level of familiarity: sleep, laughter, hunger, embarrassment, boredom, jealousy, curiosity (examples only; do not reuse historical answers)
- Make it genuinely approachable: a typical player should have a fair chance by clue 2 or 3
- Sentence 1 can be intriguing but should be understandable without decoding elaborate metaphors
- Sentence 2 MUST include a specific, recognizable everyday situation or example that points toward the answer
- Use simple vocabulary and increasingly concrete clues; avoid overly poetic, technical, or philosophical descriptions`,

  medium: `
DIFFICULTY: MEDIUM
- Choose a familiar word or concept most adults would recognize and encounter in normal reading or conversation
- Avoid academic jargon, obscure literary words, rare dictionary terms, or specialist vocabulary; do not make unfamiliar vocabulary the challenge
- Examples of the intended familiarity: nostalgia, ambition, coincidence, forgiveness, momentum, compromise, reputation (examples only; do not reuse historical answers)
- Clue 1 may be indirect, but include an ordinary real-world situation by clue 3
- By clue 4, a thoughtful player should reasonably be able to identify the specific answer instead of several equally plausible synonyms
- Aim for a fair solve in 3-4 guesses`,

  hard: `
DIFFICULTY: HARD
- Choose a nuanced, challenging word that is still recognizable to a general adult audience; difficulty should come from inference, not from an unknown technical term
- Sentence 1 can be cryptic but must have a meaningful connection to the answer
- Build toward concrete, distinguishing evidence, not just increasingly elaborate metaphors
- Clues 4 and 5 MUST include a defining characteristic, contrast, or recognizable situation that distinguishes the answer from likely near-synonyms
- Avoid puzzles where several common answers remain equally valid even after the final clue
- A thoughtful player should have a realistic chance by clue 5, even if clues 1-3 are difficult`,

  wildcard: `
DIFFICULTY: WILDCARD (Sunday)
- Surprise players with an unexpected subject or everyday phenomenon; it should feel fresh and fun, not like an obscure vocabulary exam
- Choose a recognizable answer word, even when the clues involve an interesting field such as cooking, weather, architecture, music, or science
- Avoid specialist terminology that would normally require formal training or a dictionary to identify
- Connect the topic to an accessible real-life example by clue 3, and make the answer clearly distinguishable by clue 5
- Vary the challenge between easy and medium most Sundays; keep occasional harder Sundays fair and solvable`,
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
Your job: create a puzzle. Choose a concept, emotion, phenomenon, action, or everyday object as the answer word. Write a clear, engaging 5-sentence paragraph that describes it without ever saying the word. Favor the satisfaction of recognizing a specific answer over impressively abstract prose. Elegant language is welcome, but fairness and clarity come first.

Rules:
- The answer must be a single English word (not a proper noun, not a phrase)
- Include "partOfSpeech" for the exact intended grammatical form of the answer. Use exactly one of: "Noun (singular)", "Noun (plural)", "Verb", "Verb (infinitive)", "Verb (present participle)", "Verb (past participle)", "Adjective", "Adverb"
- Every noun MUST specify number: use "Noun (singular)" for singular or mass/uncountable nouns, and "Noun (plural)" for plural nouns
- The part of speech must match how the answer itself is intended. For an -ing answer used as an action/verb form, use "Verb (present participle)"; if an -ing form is intended as a noun/gerund concept, use "Noun (singular)" unless the answer itself is plural
- The answer must be different from every prior GIST answer listed above
- The paragraph must NOT contain the answer word or obvious synonyms
- Sentence 1 should be the most indirect clue, but still understandable rather than intentionally vague
- Each following sentence must add genuinely new information and progressively narrow the possibilities
- The final two clues should make the intended answer distinguishable from plausible near-synonyms; do not rely on subjective or generic descriptions
- Sentence 5 should be the most revealing, with an unambiguous real-world example or defining characteristic (without saying the answer)
- Limit abstract metaphors; use concrete examples and natural language instead of repeated phrases like "invisible architecture" or "the space between"
- Do not make Latin/Greek roots, historical etymology, or a technical definition the only revealing part of the final clue
- The paragraph should feel precise, vivid, and fair to a general audience — not like a riddle or a vocabulary test
- Also provide 3-10 "close" words that are near-synonyms or useful word-form variations (a player guessing these gets a yellow result)
- The "close" array MUST include common variations of the answer word (verb forms, plural, adjective forms, past tense, etc.) — for example if the answer is "anticipation" include "anticipate", "anticipating", "anticipated"

Return ONLY valid JSON, no markdown, exactly this format:
{
  "answer": "loneliness",
  "partOfSpeech": "Noun (singular)",
  "difficulty": "EASY",
  "sentences": [
    "A room can be full of people and still feel strangely empty.",
    "When a close friend moves away, even familiar places may feel different without them.",
    "It is not the same as being alone, because you can enjoy time by yourself and still feel connected.",
    "Calls and messages may help, but they cannot always replace feeling understood or having someone nearby.",
    "It is the painful feeling of wanting companionship or connection and finding it missing."
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
    const candidate = sanitizePuzzle(parsePuzzleJson(raw));
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
console.log(`✅ Answer: "${puzzle.answer}" [${puzzle.partOfSpeech}; ${puzzle.difficulty}]`);
console.log(`📝 Sentences: ${puzzle.sentences.length}`);

// Read template and inject puzzle data
const template = fs.readFileSync("template.html", "utf8");
const output = template.replace("__PUZZLE_DATA__", JSON.stringify(puzzle));

fs.writeFileSync("gist.html", output);
console.log(`📄 gist.html written for puzzle #${PUZZLE_ID}`);

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
