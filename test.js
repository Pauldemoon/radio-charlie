const assert = require("assert");

process.env.RADIO_CHARLIE_FREE_MODE = "true";
process.env.RADIO_CHARLIE_STRICT_AI = "false";
process.env.VOICE_PROVIDER = "browser";

const plan = require("./server-functions/plan.js").handler;
const speak = require("./server-functions/speak.js").handler;
const status = require("./server-functions/status.js").handler;

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function run() {
  await testFreePlan();
  await testPlanValidation();
  await testBrowserVoiceFallback();
  await testStatus();

  console.log("Tests Sillage FM OK");
}

async function testFreePlan() {
  const response = await plan({
    httpMethod: "POST",
    body: JSON.stringify({
      artist: "Daft Punk",
      title: "Veridis Quo",
      album: "Discovery",
    }),
  });
  const body = JSON.parse(response.body);

  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(body.tracks.length, 8);
  assert.strictEqual(body.tracks[0].artist, "Daft Punk");
  assert.strictEqual(body.tracks[0].title, "Veridis Quo");
  assert.deepStrictEqual(
    body.tracks.map((track) => track.role),
    [
      "opener",
      "origin",
      "rupture",
      "contrast",
      "hidden influence",
      "turning point",
      "consequence",
      "closing statement",
    ],
  );
}

async function testPlanValidation() {
  const missingSeed = await plan({
    httpMethod: "POST",
    body: JSON.stringify({ artist: "", title: "" }),
  });
  const longSeed = await plan({
    httpMethod: "POST",
    body: JSON.stringify({
      artist: "A".repeat(161),
      title: "Titre",
    }),
  });

  assert.strictEqual(missingSeed.statusCode, 400);
  assert.strictEqual(longSeed.statusCode, 400);
}

async function testBrowserVoiceFallback() {
  const response = await speak({
    httpMethod: "POST",
    body: JSON.stringify({ text: "Bonjour antenne." }),
  });

  assert.strictEqual(response.statusCode, 503);
}

async function testStatus() {
  const response = await status({
    httpMethod: "GET",
    body: "",
  });
  const body = JSON.parse(response.body);

  assert.strictEqual(response.statusCode, 200);
  assert.strictEqual(body.freeMode, true);
  assert.strictEqual(body.voiceProvider, "browser");
}
