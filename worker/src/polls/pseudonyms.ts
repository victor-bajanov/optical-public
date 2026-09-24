/** Per-poll-stable pseudonyms for invitees who hide their name ("anonymous
 *  sea otter", Google-Docs flavour — see spec §7). Uniqueness is enforced
 *  only WITHIN a poll (the caller passes that poll's already-minted set); the
 *  same pseudonym naming different people across polls is fine and intended. */

export const ADJECTIVES: readonly string[] = [
  "anonymous", "curious", "cheerful", "sleepy", "witty",
  "gentle", "brave", "quiet", "clever", "jolly",
  "swift", "cosmic", "plucky", "dapper", "mellow",
  "spry", "wandering", "tranquil", "vivid", "nimble",
];

export const ANIMALS: readonly string[] = [
  "sea otter", "red panda", "polar bear", "snow leopard", "fennec fox",
  "honey badger", "arctic hare", "barn owl", "manta ray", "koala",
  "platypus", "narwhal", "octopus", "pangolin", "wallaby",
  "meerkat", "chinchilla", "axolotl", "capybara", "quokka",
];

const MAX_ATTEMPTS = ADJECTIVES.length * ANIMALS.length;

/** Pick a random "adjective animal" pair not already in `taken`. Throws once
 *  the whole 20x20 pool (400 combinations) is exhausted for this poll. */
export function mintPseudonym(taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const adjective = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    const candidate = `${adjective} ${animal}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("pseudonym pool exhausted for this poll");
}
