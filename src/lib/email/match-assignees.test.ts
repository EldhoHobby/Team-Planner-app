import { describe, expect, it } from "vitest";
import { matchAssignees, stripAssignmentMarkers, type MatchPerson } from "./match-assignees";

const charles: MatchPerson = { id: "u1", username: "charles.fry", name: "Charles Fry" };
const charlie: MatchPerson = { id: "u2", username: "charles", name: "Charles Brown" };
const aaron: MatchPerson = { id: "u3", username: "aaron", name: "Aaron" }; // single-word name
const people = [charles, charlie, aaron];

const ids = (text: string) => matchAssignees(text, people).map((p) => p.id).sort();

describe("matchAssignees — @ is REQUIRED", () => {
  it("matches @username", () => {
    expect(ids("please @charles.fry check the pump")).toEqual(["u1"]);
  });

  it("matches @Full Name, case-insensitively", () => {
    expect(ids("please @Charles Fry check the pump")).toEqual(["u1"]);
    expect(ids("please @charles fry check the pump")).toEqual(["u1"]);
  });

  it("does NOT match a full name in plain prose (no @)", () => {
    expect(ids("Charles Fry mentioned the pump is down")).toEqual([]);
  });

  it("does NOT match a bare username without @", () => {
    expect(ids("ask charles.fry about it")).toEqual([]);
  });

  it("single-word names skip the name pass but their @username still works", () => {
    // "@Aaron" isn't a multi-word-name match, but it IS the username "aaron"
    // (tags are case-insensitive), so it assigns via the username path.
    expect(ids("@Aaron should do it")).toEqual(["u3"]);
    // In plain prose, neither the name nor the username assigns.
    expect(ids("Aaron should do it")).toEqual([]);
  });

  it("@Full Name is consumed — not misread as another person's @username", () => {
    // "@Charles Fry" must tag Charles Fry (u1), NOT username "charles" (u2).
    expect(ids("assign to @Charles Fry today")).toEqual(["u1"]);
  });

  it("multiple people in one email", () => {
    expect(ids("@Charles Fry and @charles please sync")).toEqual(["u1", "u2"]);
  });

  it("email addresses in the text don't create tags", () => {
    expect(ids("reply to bob@acme.com about charles")).toEqual([]);
  });
});

describe("stripAssignmentMarkers", () => {
  it("removes matched @Full Name and @username tags from the subject", () => {
    const matched = matchAssignees("@Charles Fry @charles fix pump", people);
    expect(stripAssignmentMarkers("@Charles Fry @charles fix pump", matched)).toBe("fix pump");
  });

  it("leaves email addresses and plain names intact", () => {
    expect(stripAssignmentMarkers("Fwd: bob@acme.com about Charles Fry", [])).toBe(
      "Fwd: bob@acme.com about Charles Fry",
    );
  });
});
