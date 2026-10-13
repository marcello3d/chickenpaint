// Builds ChickenPaint and assembles dist-2draw/ with only the runtime files 2draw.net serves from
// /applet/chickenpaint/ (resourcesRoot). Copy dist-2draw/* there.
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist-2draw");
const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit" });

run("make all min");
rmSync(out, { recursive: true, force: true });

const copy = (from, to = from) => {
	mkdirSync(dirname(join(out, to)), { recursive: true });
	cpSync(join(root, from), join(out, to));
};
const copyDir = (dir, test) => {
	for (const name of readdirSync(join(root, dir), { withFileTypes: true })) {
		if (name.isFile() && test(name.name)) copy(join(dir, name.name), join(dir.replace(/^resources\//, ""), name.name));
	}
};

copy("resources/js/chickenpaint.min.js", "js/chickenpaint.min.js");
copy("resources/js/chickenpaint.min.js.map", "js/chickenpaint.min.js.map");
copy("resources/js/chickenpaint-player.min.js", "js/chickenpaint-player.min.js");
copy("resources/js/chickenpaint-player.min.js.map", "js/chickenpaint-player.min.js.map");
copy("resources/css/chickenpaint.css", "css/chickenpaint.css");
copyDir("resources/fonts", (n) => /\.(eot|svg|ttf|woff2?)$/.test(n));
copyDir("resources/gfx", (n) => n.endsWith(".png"));
copyDir("resources/splash", (n) => n.endsWith(".png"));
copy("LICENSE");

const sha = execSync("git rev-parse --short=8 HEAD", { cwd: root }).toString().trim();
const dirty = execSync("git status --porcelain --untracked-files=no", { cwd: root }).toString().trim() ? "-dirty" : "";
writeFileSync(join(out, "VERSION"), sha + dirty + "\n");
console.log(`dist-2draw/ built from ${sha}${dirty}`);
