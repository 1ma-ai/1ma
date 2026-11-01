import { describe, expect, it } from "vitest";
import { optionLabel, type Choice } from "./labels";

const server = (id: string, name: string): Choice => ({ id, name, active: false });

describe("optionLabel", () => {
  it("shortens one Linux and one Mac server", () => {
    const choices = [server("a", "Linux workstation"), server("b", "MacBook Pro")];
    expect(choices.map((choice) => optionLabel(choices, choice))).toEqual(["Linux", "Mac"]);
  });

  it("keeps full names when two servers would read the same", () => {
    const choices = [
      server("a", "Linux prod"),
      server("b", "Linux staging"),
      server("c", "Mac mini"),
    ];
    expect(choices.map((choice) => optionLabel(choices, choice))).toEqual([
      "Linux prod",
      "Linux staging",
      "Mac",
    ]);
  });

  it("leaves other names as they are", () => {
    const choices = [server("a", "Office"), server("b", "Home")];
    expect(choices.map((choice) => optionLabel(choices, choice))).toEqual(["Office", "Home"]);
  });
});
