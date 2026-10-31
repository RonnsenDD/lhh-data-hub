import unittest

from scripts.audit_workflow_schedule import audit


class AuditWorkflowScheduleTests(unittest.TestCase):
    def make_run(self, run_id, created, started, conclusion, event="schedule"):
        return {
            "id": run_id,
            "event": event,
            "created_at": created,
            "run_started_at": started,
            "conclusion": conclusion,
        }

    def test_regular_schedule_reports_last_successful_producer_job(self):
        current = self.make_run(2, "2026-10-29T12:18:00Z", "2026-10-29T12:19:00Z", None)
        prior = self.make_run(1, "2026-10-29T12:03:00Z", "2026-10-29T12:03:20Z", "success")
        problems, messages = audit(
            current, [current, prior], interval_minutes=15, max_gap_minutes=20,
            max_queue_delay_minutes=5, producer_job_name="update-weather",
            current_producer_result="success", prior_producer_results={"1": "success"})
        self.assertEqual(problems, [])
        self.assertTrue(any("last_successful_producer_run=1" in line for line in messages))

    def test_missed_slot_is_reported_as_gap_failure(self):
        current = self.make_run(3, "2026-10-29T12:33:00Z", "2026-10-29T12:34:00Z", None)
        prior = self.make_run(1, "2026-10-29T12:03:00Z", "2026-10-29T12:03:20Z", "success")
        problems, _ = audit(
            current, [current, prior], interval_minutes=15, max_gap_minutes=20,
            max_queue_delay_minutes=5, producer_job_name="update-weather",
            current_producer_result="success", prior_producer_results={"1": "success"})
        self.assertEqual(len(problems), 1)
        self.assertIn("schedule gap", problems[0])

    def test_runner_queue_delay_is_reported(self):
        current = self.make_run(2, "2026-10-29T12:18:00Z", "2026-10-29T12:25:00Z", None)
        prior = self.make_run(1, "2026-10-29T12:03:00Z", "2026-10-29T12:03:20Z", "success")
        problems, _ = audit(
            current, [current, prior], interval_minutes=15, max_gap_minutes=20,
            max_queue_delay_minutes=5, producer_job_name="update-weather",
            current_producer_result="success", prior_producer_results={"1": "success"})
        self.assertTrue(any("queue delay" in item for item in problems))

    def test_successful_producer_is_not_lost_when_later_audit_failed(self):
        current = self.make_run(3, "2026-10-29T12:33:00Z", "2026-10-29T12:34:00Z", None)
        prior = self.make_run(2, "2026-10-29T12:03:00Z", "2026-10-29T12:03:20Z", "failure")
        problems, messages = audit(
            current, [current, prior], interval_minutes=15, max_gap_minutes=20,
            max_queue_delay_minutes=5, producer_job_name="update-weather",
            current_producer_result="success", prior_producer_results={"2": "success"})
        self.assertTrue(any("schedule gap" in problem for problem in problems))
        self.assertTrue(any("current_producer_result=success" in line for line in messages))
        self.assertTrue(any("last_successful_producer_run=2" in line
                            and "workflow_run_conclusion=failure" in line for line in messages))

    def test_manual_runs_are_never_counted_as_schedule_evidence(self):
        current = self.make_run(2, "2026-10-29T12:18:00Z", "2026-10-29T12:18:01Z", None, event="workflow_dispatch")
        problems, _ = audit(
            current, [], interval_minutes=15, max_gap_minutes=20,
            max_queue_delay_minutes=5, producer_job_name="update-weather",
            current_producer_result="success", prior_producer_results={})
        self.assertTrue(any("not an automatic schedule" in item for item in problems))

class ScheduleAuditWorkflowContractTests(unittest.TestCase):
    def test_all_data_hub_schedule_audits_are_visible_but_nonfatal(self):
        from pathlib import Path
        import re

        root = Path(__file__).resolve().parents[1]
        workflows = (
            ".github/workflows/update-dwd-weather.yml",
            ".github/workflows/update-graslandfeuerindex.yml",
            ".github/workflows/update-levels.yml",
            ".github/workflows/update-radolan-ry.yml",
            ".github/workflows/update-waldbrandgefahrenstufe-osl.yml",
        )
        for relative_path in workflows:
            with self.subTest(workflow=relative_path):
                source = (root / relative_path).read_text(encoding="utf-8")
                match = re.search(
                    r"(?ms)^  schedule-audit:\n(.*?)(?=^  [a-zA-Z0-9_-]+:\n|\Z)",
                    source,
                )
                self.assertIsNotNone(match, "schedule-audit job must remain configured")
                block = match.group(1)
                self.assertRegex(block, r"(?m)^    continue-on-error: true$")
                self.assertIn("name: Schedule health (separate from producer result)", block)
                self.assertIn("run: python3 scripts/audit_workflow_schedule.py", block)


if __name__ == "__main__":
    unittest.main()
