#!/usr/bin/env python3
"""Statistical checks for analyze-creator-rules.mjs (requires scipy).

Usage: python3 tools/live-games/analyze-creator-statistics.py \
  --report artifacts/creator-rules/distributions.json \
  --output artifacts/creator-rules/statistics.json
"""
import argparse
import json
import math
from collections import Counter
from pathlib import Path

from scipy.stats import binomtest, chisquare


def uniform_fit(counts, candidate_ids):
    observed = [counts.get(str(candidate_id), 0) for candidate_id in candidate_ids]
    unexpected = sorted(set(counts) - {str(candidate_id) for candidate_id in candidate_ids})
    total = sum(observed)
    result = chisquare(observed, [total / len(observed)] * len(observed))
    return {
        "trials": total,
        "cells": len(observed),
        "chiSquare": float(result.statistic),
        "pValue": float(result.pvalue),
        "outsidePool": unexpected,
    }


def analyze_guardian(group):
    counts = group["officialCounts"]
    trials = sum(counts.values())
    specials = sum(counts.get(str(candidate_id), 0) for candidate_id in group["specialIds"])
    expected_probability = group["expectedSpecialProbability"]
    result = binomtest(specials, trials, expected_probability)
    interval = result.proportion_ci(method="wilson")
    return {
        "specials": specials,
        "trials": trials,
        "observedProbability": specials / trials,
        "expectedProbability": expected_probability,
        "wilson95": [interval.low, interval.high],
        "binomialPValue": float(result.pvalue),
        "officialUniformFit": uniform_fit(counts, group["poolIds"]),
        "localUniformFit": uniform_fit(group["localCounts"], group["poolIds"]),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    report = json.loads(arguments.report.read_text())
    confirmed = [row for row in report["overflow"]["rows"] if row["candidatesConfirmed"]]
    drop_rows = [row for row in confirmed if row["action"] == "addItem"]
    local_counts = report["overflow"]["localCountsBySlot"]
    local_result = chisquare(local_counts)
    summary = {
        "sourceFiles": report["processedFiles"],
        "readErrors": report["readErrors"],
        "guardianShapeErrors": report["guardianShapeErrors"],
        "guardianReplay": report["guardianReplay"],
        "earth": analyze_guardian(report["earth"]),
        "moon": analyze_guardian(report["moon"]),
        "overflow": {
            "recordedEvents": len(report["overflow"]["rows"]),
            "performedSelected": sum(row["performedSelected"] for row in report["overflow"]["rows"]),
            "byAction": dict(Counter(row["action"] for row in report["overflow"]["rows"])),
            "exactCandidateSnapshots": len(confirmed),
            "dropExactCandidateSnapshots": len(drop_rows),
            "dropPerformedSelected": sum(row["performedSelected"] for row in drop_rows),
            "dropExpectedPerformedSelections": sum(row["performedProbability"] for row in drop_rows),
            "dropProbabilityOfZeroPerformedSelections": math.prod(
                1 - row["performedProbability"] for row in drop_rows
            ),
            "localUniformChiSquare": float(local_result.statistic),
            "localUniformPValue": float(local_result.pvalue),
            "localPerformedProbability": sum(local_counts[:report["overflow"]["localPerformedSlots"]]) / sum(local_counts),
            "localExpectedPerformedProbability": report["overflow"]["localPerformedSlots"] / len(local_counts),
        },
        "interpretation": "Large p-values indicate compatibility, not proof of identical implementations."
    }
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
