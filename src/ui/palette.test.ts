import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast";

/*
 * The warehouse rule from CLAUDE.md: dark text on white, nothing light grey, 7:1 or better.
 * This reads the REAL colour tokens out of globals.css, so changing a colour there that breaks
 * the rule fails this test.
 */
const css = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
const token = (name: string): string => {
  const m = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{3,6})\\s*;`));
  if (!m) throw new Error(`--color-${name} is not defined in globals.css`);
  return m[1] as string;
};

const LEVELS = ["critical", "low", "normal", "high"] as const;

describe("palette contrast (target 7:1, WCAG AAA for normal text)", () => {
  it("body text and secondary text on the white page", () => {
    expect(contrastRatio(token("ink"), token("page"))).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(token("ink-soft"), token("page"))).toBeGreaterThanOrEqual(7); // there is no 'light grey' text
  });

  it("the page really is white", () => {
    expect(token("page").toLowerCase()).toMatch(/^#(fff|ffffff)$/);
  });

  it("primary button: white label on its fill", () => {
    expect(contrastRatio(token("action-text"), token("action"))).toBeGreaterThanOrEqual(7);
  });

  it("the focus ring and borders are visible against the page (UI components need 3:1; we ask for 7:1)", () => {
    expect(contrastRatio(token("focus"), token("page"))).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(token("border"), token("page"))).toBeGreaterThanOrEqual(7);
  });

  it.each(LEVELS)("status %s: text on its tinted background, and its border against the page", (level) => {
    expect(contrastRatio(token(`status-${level}`), token(`status-${level}-bg`))).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(token(`status-${level}`), token("page"))).toBeGreaterThanOrEqual(7);
  });

  it("the four status colours are four different colours (and the UI adds an icon and a word on top)", () => {
    const colours = LEVELS.map((l) => token(`status-${l}`).toLowerCase());
    expect(new Set(colours).size).toBe(4);
  });

  it("error and pending states are legible too", () => {
    expect(contrastRatio(token("danger"), token("danger-bg"))).toBeGreaterThanOrEqual(7);
    expect(contrastRatio(token("ink"), token("pending-bg"))).toBeGreaterThanOrEqual(7);
  });
});
