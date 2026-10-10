// Reads and writes /projects.js, the file behind the home page's cards and
// The Path So Far. Used by /workshop/ in the browser (window.ProjectsFormat)
// and by Node (require). The file is plain JSON wrapped in one assignment,
// written with one change per line so diffs stay small.
(function (root) {
  const HEADER =
    "// Tavernworks projects: the cards on the home page and every change on\n" +
    "// The Path So Far. Edit by hand or at /workshop/.\n" +
    "//\n" +
    "// projects: one per lane on the path, in card order. dir is the project's\n" +
    "//   folder in this repo (\".\" for the whole repo, \"\" if it lives\n" +
    "//   elsewhere); card is null for projects without a card in The Bots or\n" +
    "//   The Workbench.\n" +
    "// changes: [project key, date, what changed, where it lives], oldest first.\n" +
    "// shown: how many of the most recently changed projects get a lane.\n" +
    "//\n" +
    "// Everything after \"window.TAVERN_PROJECTS =\" must stay plain JSON.\n";
  const PREFIX = "window.TAVERN_PROJECTS = ";

  function parse(text) {
    const at = text.indexOf(PREFIX);
    if (at < 0) throw new Error("projects.js doesn't contain \"" + PREFIX.trim() + "\".");
    const body = text.slice(at + PREFIX.length).trim().replace(/;\s*$/, "");
    return JSON.parse(body);
  }

  function serialize(data) {
    const j = (v) => JSON.stringify(v);
    const indent = (s, n) => s.replace(/\n/g, "\n" + " ".repeat(n));
    const projects = data.projects.map((p) => "    " + indent(JSON.stringify(p, null, 2), 4));
    const changes = data.changes.map((c) => "    " + j([c.lane, c.date, c.title, c.href]));
    return HEADER + PREFIX + "{\n" +
      '  "shown": ' + j(data.shown) + ",\n" +
      '  "projects": [\n' + projects.join(",\n") + "\n  ],\n" +
      '  "changes": [\n' + changes.join(",\n") + "\n  ]\n" +
      "};\n";
  }

  // Changes are stored as arrays; work with them as objects.
  function load(text) {
    const d = parse(text);
    return { ...d, changes: d.changes.map(([lane, date, title, href]) => ({ lane, date, title, href })) };
  }

  const api = { parse, serialize, load };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ProjectsFormat = api;
})(this);
