import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RemoteSystemService } from "./remote-system-service.ts";

describe("RemoteSystemService", () => {
  it("requires OS detection, truncates output, and kills a long shell task", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-gui-remote-system-"));
    const service = new RemoteSystemService();
    const clientId = "test-client";
    try {
      await writeFile(path.join(root, "large.txt"), "界".repeat(6_000));
      await expect(service.invokeFile(clientId, "read-file", { rootPath: root, path: path.join(root, "large.txt") })).rejects.toThrow("get-operating-system");

      expect(service.getOperatingSystem(clientId)).toHaveProperty("operatingSystem");
      const read = await service.invokeFile(clientId, "read-file", { rootPath: root, path: path.join(root, "large.txt") }) as { output: string; truncated: boolean };
      expect(JSON.stringify(read).length).toBeLessThanOrEqual(5_000);
      expect(read.truncated).toBe(true);
      expect(read.output).toEndWith("… 后续内容超过5000字符，已省略。");

      await writeFile(path.join(root, "matches.txt"), "match\n".repeat(20_000));
      const grep = await service.invokeFile(clientId, "grep-files", {
        rootPath: root,
        path: root,
        keyword: "match",
      }) as { output: string; truncated: boolean };
      expect(grep.output.length).toBeLessThanOrEqual(5_000);
      expect(JSON.stringify(grep).length).toBeLessThanOrEqual(5_000);
      expect(grep.output).toEndWith("… 后续内容超过5000字符，已省略。");

      const filteredRoot = path.join(root, "filtered");
      await mkdir(path.join(filteredRoot, "excluded"), { recursive: true });
      await writeFile(path.join(filteredRoot, "keep.ts"), "needle");
      await writeFile(path.join(filteredRoot, "ignored.log"), "needle");
      await writeFile(path.join(filteredRoot, "excluded", "hidden.ts"), "needle");
      const exclusions = { exclude: ["excluded", "*.log"] };
      const tree = await service.invokeFile(clientId, "get-directory-tree", {
        rootPath: root,
        path: filteredRoot,
        depth: 2,
        ...exclusions,
      }) as { output: string };
      expect(tree.output).toContain("keep.ts");
      expect(tree.output).not.toContain("ignored.log");
      expect(tree.output).not.toContain("hidden.ts");
      const find = await service.invokeFile(clientId, "find-files", {
        rootPath: root,
        path: filteredRoot,
        ...exclusions,
      }) as { output: string };
      expect(find.output).toContain("keep.ts");
      expect(find.output).not.toContain("ignored.log");
      expect(find.output).not.toContain("hidden.ts");
      const filteredGrep = await service.invokeFile(clientId, "grep-files", {
        rootPath: root,
        path: filteredRoot,
        keyword: "needle",
        ...exclusions,
      }) as { output: string };
      expect(filteredGrep.output).toContain("keep.ts");
      expect(filteredGrep.output).not.toContain("ignored.log");
      expect(filteredGrep.output).not.toContain("hidden.ts");

      const writtenPath = path.join(root, "new", "nested.txt");
      expect(await service.invokeFile(clientId, "write-file", {
        rootPath: root,
        path: writtenPath,
        content: "one one two",
      })).toMatchObject({ saved: true });
      expect(await readFile(writtenPath, "utf8")).toBe("one one two");

      expect(await service.invokeFile(clientId, "replace-in-file", {
        rootPath: root,
        path: writtenPath,
        search: "o.e",
        replace: "three",
        useRegex: true,
        replaceAll: true,
      })).toMatchObject({ saved: true, replaced: 2 });
      expect(await readFile(writtenPath, "utf8")).toBe("three three two");

      expect(await service.invokeFile(clientId, "replace-in-file", {
        rootPath: root,
        path: writtenPath,
        search: "missing",
        replace: "changed",
      })).toMatchObject({ saved: false, replaced: 0, error: "Search string not found in target file." });
      expect(await readFile(writtenPath, "utf8")).toBe("three three two");
      expect(await service.invokeFile(clientId, "replace-in-file", {
        rootPath: root,
        path: writtenPath,
        search: "[",
        replace: "changed",
        useRegex: true,
      })).toHaveProperty("error");

      const outside = await mkdtemp(path.join(os.tmpdir(), "pi-gui-remote-outside-"));
      try {
        await symlink(outside, path.join(root, "escape"));
        expect(await service.invokeFile(clientId, "write-file", {
          rootPath: root,
          path: path.join(root, "escape", "allowed.txt"),
          content: "allowed",
        })).toMatchObject({ saved: true });
        expect(await readFile(path.join(outside, "allowed.txt"), "utf8")).toBe("allowed");
      } finally {
        await rm(outside, { recursive: true, force: true });
      }

      const shellOutput = await service.executeShell(clientId, {
        cwd: root,
        command: `"${process.execPath}" -e "process.stdout.write('x'.repeat(10000))"`,
        waitMs: 5_000,
      }) as { output: string; truncated: boolean };
      expect(JSON.stringify(shellOutput).length).toBeLessThanOrEqual(5_000);
      expect(shellOutput.output).toEndWith("… 后续内容超过5000字符，已省略。");

      const started = await service.executeShell(clientId, {
        cwd: root,
        command: `"${process.execPath}" -e "setTimeout(() => {}, 10000)"`,
        waitMs: 10,
      }) as { taskId: string; status: string };
      expect(started.status).toBe("running");
      const killed = await service.killShell(clientId, { taskId: started.taskId }) as { status: string };
      expect(killed.status).toBe("killed");
    } finally {
      service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("collects directory metadata, reads chunks, and rejects imports over 500 MB", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-gui-import-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "pi-gui-import-outside-"));
    const sourceDir = path.join(outside, "folder");
    const sourceFile = path.join(sourceDir, "data.bin");
    const tooLarge = path.join(outside, "too-large.bin");
    await mkdir(sourceDir);
    await writeFile(sourceFile, Buffer.from([0, 1, 2, 3]));
    const largeFile = await open(tooLarge, "w");
    await largeFile.truncate(500 * 1024 * 1024 + 1);
    await largeFile.close();

    const service = new RemoteSystemService();
    service.getOperatingSystem("test");
    try {
      const metadata = await service.invokeFile("test", "get-import-files-metadata", {
        rootPath: root,
        path: sourceDir,
        paths: [sourceDir],
      }) as { files: Array<{ relativePath: string; size: number; md5: string }>; totalSize: number };
      expect(metadata).toEqual({
        files: [{
          path: await realpath(sourceFile),
          relativePath: "folder/data.bin",
          size: 4,
          md5: createHash("md5").update(Buffer.from([0, 1, 2, 3])).digest("hex"),
        }],
        totalSize: 4,
      });

      const chunk = await service.invokeFile("test", "read-import-file-chunk", {
        rootPath: root,
        path: sourceFile,
        offset: 1,
        length: 2,
      }) as { bytesRead: number; content: string; eof: boolean };
      expect(chunk.bytesRead).toBe(2);
      expect(Buffer.from(chunk.content, "base64")).toEqual(Buffer.from([1, 2]));
      expect(chunk.eof).toBe(false);

      await expect(service.invokeFile("test", "get-import-files-metadata", {
        rootPath: root,
        path: tooLarge,
        paths: [tooLarge],
      })).rejects.toThrow("500 MB");
    } finally {
      service.dispose();
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
