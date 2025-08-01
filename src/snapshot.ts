import * as fs from "fs";
import * as path from "path";
import * as assert from "assert";

export class SnapshotTester {
  private snapshotDir: string;
  private updateSnapshots: boolean;

  constructor(testFilePath: string, updateSnapshots: boolean = false) {
    // Always put snapshots in src/__snapshots__ regardless of where the compiled test runs from
    const srcDir = path.join(__dirname, "..", "src");
    this.snapshotDir = path.join(srcDir, "__snapshots__");
    this.updateSnapshots = updateSnapshots;

    // Create snapshots directory if it doesn't exist
    if (!fs.existsSync(this.snapshotDir)) {
      fs.mkdirSync(this.snapshotDir, { recursive: true });
    }
  }

  expectSnapshot(testName: string, actual: string): void {
    const snapshotFile = path.join(this.snapshotDir, `${testName}.snap`);

    if (this.updateSnapshots || !fs.existsSync(snapshotFile)) {
      // Write/update snapshot
      fs.writeFileSync(snapshotFile, actual, "utf8");
      if (this.updateSnapshots) {
        console.log(`Updated snapshot: ${testName}`);
      } else {
        console.log(`Created snapshot: ${testName}`);
      }
    } else {
      // Compare with existing snapshot
      const expected = fs.readFileSync(snapshotFile, "utf8");
      assert.strictEqual(actual, expected, `Snapshot mismatch for ${testName}`);
    }
  }
}

// Global helper to create snapshot tester for current test file
export function createSnapshotTester(): SnapshotTester {
  // Check environment variable to determine if we should update snapshots
  const updateSnapshots = process.env.UPDATE_SNAPSHOTS === "true";

  // Get the test file path from the stack trace
  const stack = new Error().stack;
  const testFilePath = stack?.split("\n")
    .map((line) => line.match(/\((.*\.test\.ts):/))
    .find((match) => match)?.[1] || __filename;

  return new SnapshotTester(testFilePath, updateSnapshots);
}
