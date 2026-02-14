const test = require("node:test");
const assert = require("node:assert/strict");

const {
  YOUTUBE_TITLE_BLOCK_TERMS,
  YOUTUBE_TITLE_WEIGHT_RULES,
  YOUTUBE_CHANNEL_WEIGHT_RULES,
  YOUTUBE_SEARCH_QUERY_VARIANTS,
} = require("../src/config/constants");

function assertNonEmptyString(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.equal(value.trim().length > 0, true, `${label} must be non-empty`);
}

function assertWeightRules(rules, label) {
  assert.equal(Array.isArray(rules), true, `${label} must be an array`);
  rules.forEach((rule, index) => {
    assert.equal(typeof rule, "object", `${label}[${index}] must be an object`);
    assertNonEmptyString(rule?.term, `${label}[${index}].term`);
    assert.equal(Number.isFinite(rule?.score), true, `${label}[${index}].score must be a finite number`);
  });
}

test("YouTube block terms are valid strings", () => {
  assert.equal(Array.isArray(YOUTUBE_TITLE_BLOCK_TERMS), true, "YOUTUBE_TITLE_BLOCK_TERMS must be an array");
  YOUTUBE_TITLE_BLOCK_TERMS.forEach((term, index) => {
    assertNonEmptyString(term, `YOUTUBE_TITLE_BLOCK_TERMS[${index}]`);
  });
});

test("YouTube weight rules are valid", () => {
  assertWeightRules(YOUTUBE_TITLE_WEIGHT_RULES, "YOUTUBE_TITLE_WEIGHT_RULES");
  assertWeightRules(YOUTUBE_CHANNEL_WEIGHT_RULES, "YOUTUBE_CHANNEL_WEIGHT_RULES");
});

test("YouTube search query variants are valid templates", () => {
  assert.equal(Array.isArray(YOUTUBE_SEARCH_QUERY_VARIANTS), true, "YOUTUBE_SEARCH_QUERY_VARIANTS must be an array");
  assert.equal(YOUTUBE_SEARCH_QUERY_VARIANTS.length > 0, true, "YOUTUBE_SEARCH_QUERY_VARIANTS must not be empty");
  YOUTUBE_SEARCH_QUERY_VARIANTS.forEach((variant, index) => {
    assertNonEmptyString(variant, `YOUTUBE_SEARCH_QUERY_VARIANTS[${index}]`);
    assert.equal(
      variant.includes("{query}"),
      true,
      `YOUTUBE_SEARCH_QUERY_VARIANTS[${index}] must include "{query}"`
    );
  });
});
