"""Exercise the guarded publisher against temporary local bare Git remotes only."""
from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts/publish_one_snapshot.sh"
TARGET = "data/generated/dwd-weather.json"


def git(args, cwd, *, check=True, env=None):
    return subprocess.run(["git", *args], cwd=cwd, text=True, capture_output=True,
                          check=check, env=env)


class PublishOneSnapshotTests(unittest.TestCase):
    def make_repos(self, root: Path):
        bare = root / "remote.git"
        seed = root / "seed"
        work = root / "work"
        racer = root / "racer"
        git(["init", "--bare", "--initial-branch=main", str(bare)], root)
        seed.mkdir()
        git(["init", "--initial-branch=main"], seed)
        git(["config", "user.name", "Fixture"], seed)
        git(["config", "user.email", "fixture@example.invalid"], seed)
        (seed / "README.md").write_text("base\n")
        target = seed / TARGET
        target.parent.mkdir(parents=True)
        target.write_text('{"generation": 1}\n')
        git(["add", "README.md", TARGET], seed)
        git(["commit", "-m", "seed"], seed)
        git(["remote", "add", "origin", str(bare)], seed)
        git(["push", "origin", "main"], seed)
        git(["clone", str(bare), str(work)], root)
        git(["clone", str(bare), str(racer)], root)
        for repo in (work, racer):
            git(["config", "user.name", "Fixture"], repo)
            git(["config", "user.email", "fixture@example.invalid"], repo)
        (work / TARGET).write_text('{"generation": 2}\n')
        hook = work / ".git/hooks/pre-push"
        hook.write_text("""#!/bin/bash
set -euo pipefail
counter_file=\"$RACE_COUNTER\"
count=0
[[ -f \"$counter_file\" ]] && count=$(cat \"$counter_file\")
count=$((count + 1))
printf '%s' \"$count\" > \"$counter_file\"
if [[ \"$RACE_MODE\" == \"unrelated\" && \"$count\" -gt 1 ]]; then exit 0; fi
if [[ \"$RACE_MODE\" == \"unrelated\" ]]; then
  printf 'remote update\\n' >> \"$RACER_DIR/README.md\"
elif [[ \"$RACE_MODE\" == \"same-target\" ]]; then
  printf '{\\\"remoteGeneration\\\":true}\\n' > \"$RACER_DIR/data/generated/dwd-weather.json\"
else
  printf 'advance %s\\n' \"$count\" > \"$RACER_DIR/race-$count.txt\"
fi
git -C \"$RACER_DIR\" add -A
git -C \"$RACER_DIR\" commit -m \"race $count\" >/dev/null
git -C \"$RACER_DIR\" push origin main >/dev/null
exit 1
""")
        hook.chmod(0o755)
        return bare, work, racer

    def run_helper(self, work, racer, mode, targets=None):
        counter = work.parent / "race-count"
        env = os.environ.copy()
        env.update({"RACE_COUNTER": str(counter), "RACE_MODE": mode, "RACER_DIR": str(racer)})
        targets = targets or [TARGET]
        return subprocess.run(["bash", str(HELPER), "--message", "Update local fixture", *targets], cwd=work,
                              env=env, text=True, capture_output=True)

    def test_unrelated_remote_update_is_fetched_rebased_and_retried(self):
        with tempfile.TemporaryDirectory(prefix="publisher-unrelated-") as temp:
            root = Path(temp)
            bare, work, racer = self.make_repos(root)
            result = self.run_helper(work, racer, "unrelated")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("Published", result.stdout)
            paths = git(["show", "--pretty=format:", "--name-only", "main"], work).stdout.split()
            self.assertEqual(paths, [TARGET])
            remote = git(["--git-dir", str(bare), "show", "main:README.md"], root).stdout
            self.assertIn("remote update", remote)
            content = git(["--git-dir", str(bare), "show", f"main:{TARGET}"], root).stdout
            self.assertIn('"generation": 2', content)

    def test_uncommitted_snapshot_survives_rebase_after_other_producer_advances_main(self):
        with tempfile.TemporaryDirectory(prefix="publisher-dirty-rebase-") as temp:
            root = Path(temp)
            bare, work, racer = self.make_repos(root)
            hook = work / ".git/hooks/pre-push"
            hook.unlink()

            # Producer output is already generated but still uncommitted locally.
            self.assertIn(TARGET, git(["status", "--porcelain"], work).stdout)
            generated = (work / TARGET).read_text()

            # A separate producer advances main on an unrelated path meanwhile.
            (racer / "README.md").write_text("base\\nparallel producer update\\n")
            git(["add", "README.md"], racer)
            git(["commit", "-m", "parallel producer"], racer)
            git(["push", "origin", "main"], racer)

            result = self.run_helper(work, racer, "no-race")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

            published = git(["--git-dir", str(bare), "show", f"main:{TARGET}"], root).stdout
            remote_readme = git(["--git-dir", str(bare), "show", "main:README.md"], root).stdout
            self.assertEqual(published, generated)
            self.assertIn("parallel producer update", remote_readme)
            self.assertEqual(git(["status", "--porcelain"], work).stdout, "")
            self.assertEqual(git(["rev-parse", "HEAD"], work).stdout.strip(),
                             git(["rev-parse", "refs/remotes/origin/main"], work).stdout.strip())
            parent_readme = git(["show", "HEAD^:README.md"], work).stdout
            self.assertIn("parallel producer update", parent_readme)

    def test_same_target_remote_update_aborts_without_overwrite(self):
        with tempfile.TemporaryDirectory(prefix="publisher-same-target-") as temp:
            root = Path(temp)
            bare, work, racer = self.make_repos(root)
            result = self.run_helper(work, racer, "same-target")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("changed remotely", result.stderr)
            content = git(["--git-dir", str(bare), "show", f"main:{TARGET}"], root).stdout
            self.assertIn("remoteGeneration", content)
            self.assertNotIn('"generation": 2', content)

    def test_repeated_remote_advances_stop_after_bounded_retries(self):
        with tempfile.TemporaryDirectory(prefix="publisher-bounded-") as temp:
            root = Path(temp)
            bare, work, racer = self.make_repos(root)
            result = self.run_helper(work, racer, "advance")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("after 3 attempts", result.stderr)
            count = int((root / "race-count").read_text())
            self.assertEqual(count, 3)

    def test_multiple_disjoint_allowlisted_snapshots_publish_together(self):
        with tempfile.TemporaryDirectory(prefix="publisher-multiple-") as temp:
            root = Path(temp)
            bare, work, racer = self.make_repos(root)
            second = "data/generated/pegel-biehlen-1.json"
            second_path = work / second
            second_path.parent.mkdir(parents=True, exist_ok=True)
            second_path.write_text('{"station": "Biehlen 1"}\n')
            result = self.run_helper(work, racer, "unrelated", [TARGET, second])
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            committed_paths = git(["show", "--pretty=format:", "--name-only", "main"], work).stdout.split()
            self.assertEqual(set(committed_paths), {TARGET, second})
            self.assertIn("remote update", git(["--git-dir", str(bare), "show", "main:README.md"], root).stdout)
            self.assertIn("Biehlen 1", git(["--git-dir", str(bare), "show", f"main:{second}"], root).stdout)

    def test_non_allowlisted_target_is_rejected_before_staging(self):
        with tempfile.TemporaryDirectory(prefix="publisher-allowlist-") as temp:
            root = Path(temp)
            _, work, racer = self.make_repos(root)
            result = subprocess.run(["bash", str(HELPER), "--message", "fixture", "README.md"], cwd=work,
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn("non-allowlisted", result.stderr)


if __name__ == "__main__":
    unittest.main()
