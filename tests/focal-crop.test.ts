/**
 * Focal crop and responsive image variant generator (Spike 688 / phase-142) — tests
 * Run: npx tsx tests/focal-crop.test.ts
 */
import assert from "node:assert/strict";
import {
  calculateFocalCrop,
  normalizeFocalPoint,
  estimateFocalPointFromKeywords,
  buildVariantUrl,
  parseTransformParams,
  generateArtifactVariants,
  STANDARD_IMAGE_VARIANTS,
} from "@/lib/focal-crop";
import { getSecurityCounter, resetSecurityCounters } from "@/lib/security-counters";

function testNormalization() {
  assert.deepEqual(normalizeFocalPoint(null), { x: 0.5, y: 0.5 });
  assert.deepEqual(normalizeFocalPoint({ x: 0.2, y: 0.8 }), { x: 0.2, y: 0.8 });
  assert.deepEqual(normalizeFocalPoint({ x: -1, y: 2 }), { x: 0, y: 1 });
}

function testKeywordEstimation() {
  resetSecurityCounters();
  const portrait = estimateFocalPointFromKeywords("A striking portrait of a digital cybernetic warrior");
  assert.equal(portrait.y, 0.35, "Portrait should bias focal point upwards toward face");

  const landscape = estimateFocalPointFromKeywords("Stellar night sky with nebulae on the left side");
  assert.equal(landscape.x, 0.3);
  assert.equal(landscape.y, 0.3);

  assert.ok(getSecurityCounter("image_crop_focal_computed") > 0);
}

function testSquareCropFromLandscape() {
  const src = { width: 2000, height: 1000 };
  const targetAspect = 1.0; // square

  // Center focal point (0.5, 0.5)
  const centerCrop = calculateFocalCrop(src, targetAspect, { x: 0.5, y: 0.5 });
  assert.equal(centerCrop.height, 1000);
  assert.equal(centerCrop.width, 1000);
  assert.equal(centerCrop.x, 500); // centered in 2000 width
  assert.equal(centerCrop.y, 0);

  // Left focal point (0.1, 0.5)
  const leftCrop = calculateFocalCrop(src, targetAspect, { x: 0.1, y: 0.5 });
  assert.equal(leftCrop.width, 1000);
  assert.equal(leftCrop.x, 0, "Crop window should clamp to left boundary");

  // Right focal point (0.9, 0.5)
  const rightCrop = calculateFocalCrop(src, targetAspect, { x: 0.9, y: 0.5 });
  assert.equal(rightCrop.width, 1000);
  assert.equal(rightCrop.x, 1000, "Crop window should clamp to right boundary (2000 - 1000)");
}

function testBannerCropFromSquare() {
  const src = { width: 1000, height: 1000 };
  const targetAspect = 2.0; // 2:1 landscape

  // Top focal point
  const topCrop = calculateFocalCrop(src, targetAspect, { x: 0.5, y: 0.1 });
  assert.equal(topCrop.width, 1000);
  assert.equal(topCrop.height, 500);
  assert.equal(topCrop.y, 0, "Top crop should clamp to top boundary");

  // Bottom focal point
  const bottomCrop = calculateFocalCrop(src, targetAspect, { x: 0.5, y: 0.9 });
  assert.equal(bottomCrop.width, 1000);
  assert.equal(bottomCrop.height, 500);
  assert.equal(bottomCrop.y, 500, "Bottom crop should clamp to bottom boundary");
}

function testUrlBuildingAndParsing() {
  const url = buildVariantUrl("ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi", "thumbnail", { x: 0.3, y: 0.7 });
  assert.ok(url.includes("variant=thumbnail"));
  assert.ok(url.includes("fx=0.30"));
  assert.ok(url.includes("fy=0.70"));

  const parsed = parseTransformParams(new URLSearchParams(url.split("?")[1]));
  assert.equal(parsed.variant, "thumbnail");
  assert.equal(parsed.width, 256);
  assert.equal(parsed.height, 256);
  assert.equal(parsed.focal.x, 0.3);
  assert.equal(parsed.focal.y, 0.7);
}

function testGenerateArtifactVariants() {
  const baseUri = "ipfs://QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco";
  const variants = generateArtifactVariants(baseUri, { width: 2048, height: 2048 }, { x: 0.4, y: 0.6 });

  assert.ok(variants.thumbnail);
  assert.equal(variants.thumbnail.width, STANDARD_IMAGE_VARIANTS.thumbnail.width);
  assert.equal(variants.thumbnail.height, STANDARD_IMAGE_VARIANTS.thumbnail.height);
  assert.ok(variants.og);
  assert.equal(variants.og.width, 1200);
  assert.equal(variants.og.height, 630);
  assert.ok(variants.og.crop.width <= 2048);
  assert.ok(variants.og.crop.height <= 2048);
}

async function main() {
  testNormalization();
  console.log("✓ normalizeFocalPoint clamps within bounds");
  testKeywordEstimation();
  console.log("✓ estimateFocalPointFromKeywords identifies subject cues");
  testSquareCropFromLandscape();
  console.log("✓ calculateFocalCrop centers and clamps landscape to square");
  testBannerCropFromSquare();
  console.log("✓ calculateFocalCrop centers and clamps square to banner");
  testUrlBuildingAndParsing();
  console.log("✓ buildVariantUrl and parseTransformParams preserve parameters");
  testGenerateArtifactVariants();
  console.log("✓ generateArtifactVariants produces complete multi-aspect set");
  console.log("\nAll focal-crop tests passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
