import { describe, it, expect } from "vitest";
import { ADJECTIVES, ANIMALS, mintPseudonym } from "../../src/polls/pseudonyms";

describe("pseudonyms wordlists", () => {
  it("has exactly 20 adjectives and 20 animals", () => {
    expect(ADJECTIVES).toHaveLength(20);
    expect(ANIMALS).toHaveLength(20);
  });
});

describe("mintPseudonym", () => {
  it("returns an 'adjective animal' pair drawn from the wordlists", () => {
    const p = mintPseudonym(new Set());
    const [adjective, ...animalWords] = p.split(" ");
    expect(ADJECTIVES).toContain(adjective);
    expect(ANIMALS).toContain(animalWords.join(" "));
  });

  it("never returns a pseudonym already in the taken set", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const p = mintPseudonym(taken);
      expect(taken.has(p)).toBe(false);
      taken.add(p);
    }
    expect(taken.size).toBe(50);
  });

  it("throws once every combination in the 20x20 pool is taken", () => {
    const taken = new Set<string>();
    for (const a of ADJECTIVES) for (const n of ANIMALS) taken.add(`${a} ${n}`);
    expect(taken.size).toBe(400);
    expect(() => mintPseudonym(taken)).toThrow();
  });
});
