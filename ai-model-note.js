// What kind of AI model the laptop is running, worked out from its name, and
// the wording that goes with it. Wake in Verrowen, the Orrery's lore-keeper
// and the Terms all use this, so they always describe the model actually in
// use (the owner can switch it at any time with Change AI model).
//
// A model counts as abliterated when its name says so: Ollama names for these
// carry "abliterated" (e.g. huihui_ai/gemma3-abliterated:4b), and some older
// ones "uncensored". Anything else is a standard model.
(function () {
  const AI = "https://sheamus-tuf-gaming-fx705dt-fx705dt.tail2c8da4.ts.net:8443";
  const ABLITERATED = /abliterat|uncensor/i;

  function kind(model) {
    if (!model) return "unknown";
    return ABLITERATED.test(model) ? "abliterated" : "standard";
  }

  // A sentence or two for the AI's own page. `who` is "narrator" or "lore-keeper".
  function text(model, who) {
    switch (kind(model)) {
      case "abliterated":
        return `The ${who} runs on ${model}, an abliterated AI model (an open model with its refusal training removed), because of the inherent degeneracy and foul language of our users. It won't flinch at what you type, and it can get crude, violent or offensive back.`;
      case "standard":
        return `The ${who} runs on ${model}, a standard AI model with its usual safety training, so it may refuse or tone down some of what you type.`;
      default:
        return "";
    }
  }

  // A few words for a status line.
  function short(model) {
    switch (kind(model)) {
      case "abliterated": return "Abliterated model, because of our users' degeneracy and foul language";
      case "standard": return "Standard model: it may refuse some requests";
      default: return "";
    }
  }

  // The model the laptop runs right now, or "" when it can't be reached.
  function check(url) {
    return fetch((url || AI) + "/health").then((r) => r.json()).then((j) => j.model || "").catch(() => "");
  }

  window.AiModelNote = { kind, text, short, check };
})();
