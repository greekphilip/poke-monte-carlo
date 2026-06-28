#!/usr/bin/env python3
"""Map a PriceCharting export, preserve collection membership, and fill missing prices."""

from __future__ import annotations

import argparse
import json
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from lightgbm import LGBMRegressor
from sklearn.compose import ColumnTransformer
from sklearn.experimental import enable_halving_search_cv  # noqa: F401
from sklearn.feature_extraction.text import CountVectorizer
from sklearn.model_selection import HalvingRandomSearchCV
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import TargetEncoder

warnings.filterwarnings("ignore")

PRICE_COLUMNS = [
    "ungraded",
    "psa_7",
    "psa_8",
    "psa_9",
    "psa_9_5",
    "psa_10",
    "bgs_10",
    "cgc_10",
    "sgc_10",
]
REPORT_COLUMNS = [
    ("ungraded", "Ungraded"),
    ("psa_7", "PSA 7"),
    ("psa_8", "PSA 8"),
    ("psa_9", "PSA 9"),
    ("psa_10", "PSA 10"),
]

SOURCE_MAPPING = {
    "id": "id",
    "console-name": "set_name",
    "product-name": "card_name",
    "loose-price": "ungraded",
    "cib-price": "psa_7",
    "new-price": "psa_8",
    "graded-price": "psa_9",
    "box-only-price": "psa_9_5",
    "manual-only-price": "psa_10",
    "bgs-10-price": "bgs_10",
    "condition-17-price": "cgc_10",
    "condition-18-price": "sgc_10",
    "release-date": "release_date",
}


def emit(event: str, **payload: object) -> None:
    print("@@STATUS@@" + json.dumps({"event": event, **payload}), flush=True)


def parse_price(series: pd.Series) -> pd.Series:
    return pd.to_numeric(
        series.astype("string").str.replace("$", "", regex=False).str.replace(",", "", regex=False),
        errors="coerce",
    ).astype("float64")


def map_and_validate(download_path: Path, current_path: Path) -> pd.DataFrame:
    source = pd.read_csv(download_path, dtype="string")
    missing_headers = [name for name in SOURCE_MAPPING if name not in source.columns]
    if missing_headers:
        raise ValueError(
            "PriceCharting export is missing required columns: " + ", ".join(missing_headers)
        )

    mapped = source[list(SOURCE_MAPPING)].rename(columns=SOURCE_MAPPING)
    mapped["id"] = mapped["id"].astype("string")
    for column in PRICE_COLUMNS:
        mapped[column] = parse_price(mapped[column])

    current = pd.read_csv(current_path, dtype={"id": "string"})
    required_current = {"id", "set_name", "card_name"}
    if not required_current.issubset(current.columns):
        raise ValueError("The active dataset lacks id, set_name, or card_name.")
    if current["id"].duplicated().any():
        raise ValueError("The active dataset contains duplicate IDs; refresh cannot be made safely.")
    if mapped["id"].duplicated().any():
        raise ValueError("The PriceCharting export contains duplicate IDs.")

    source_by_id = mapped.set_index("id", drop=False)
    missing_ids = [card_id for card_id in current["id"] if card_id not in source_by_id.index]
    if missing_ids:
        sample = ", ".join(missing_ids[:8])
        raise ValueError(
            f"{len(missing_ids)} current cards are absent from the new export (sample: {sample})."
        )

    filtered = source_by_id.loc[current["id"]].reset_index(drop=True)
    set_mismatch = filtered["set_name"].fillna("") != current["set_name"].fillna("")
    card_mismatch = filtered["card_name"].fillna("") != current["card_name"].fillna("")
    mismatch = set_mismatch | card_mismatch
    if mismatch.any():
        first = int(np.flatnonzero(mismatch.to_numpy())[0])
        raise ValueError(
            "Card identity changed for ID "
            f"{current.iloc[first]['id']}: expected "
            f"{current.iloc[first]['set_name']} / {current.iloc[first]['card_name']}, got "
            f"{filtered.iloc[first]['set_name']} / {filtered.iloc[first]['card_name']}."
        )

    # Only market prices (and the derived Z-score) are allowed to change.
    filtered["id"] = current["id"].to_numpy()
    filtered["set_name"] = current["set_name"].to_numpy()
    filtered["card_name"] = current["card_name"].to_numpy()
    if "release_date" in current.columns:
        filtered["release_date"] = current["release_date"].to_numpy()

    emit(
        "step_detail",
        step="map",
        detail=(
            f"Mapped {len(source):,} export rows and retained the same "
            f"{len(filtered):,} cards in original order."
        ),
    )
    return filtered


def fill_missing_prices(frame: pd.DataFrame) -> tuple[pd.DataFrame, int]:
    working = frame.copy()
    filled = frame.copy()
    initial_missing = 0

    for grade in PRICE_COLUMNS:
        working[grade] = pd.to_numeric(working[grade], errors="coerce")
        working.loc[working[grade] < 1.0, grade] = np.nan
        filled[grade] = pd.to_numeric(filled[grade], errors="coerce")
        initial_missing += int(working[grade].isna().sum())

    working["card_name"] = working["card_name"].fillna("")
    working["set_name"] = working["set_name"].fillna("Unknown")
    working["release_year"] = pd.to_datetime(
        working["release_date"], errors="coerce"
    ).dt.year
    median_year = working["release_year"].median()
    working["release_year"] = working["release_year"].fillna(
        median_year if pd.notna(median_year) else 2024
    )

    for target_index, target in enumerate(PRICE_COLUMNS, start=1):
        train_mask = working[target].notna()
        predict_mask = working[target].isna()
        train_frame = working[train_mask].copy()
        predict_frame = working[predict_mask].copy()

        if len(predict_frame) == 0:
            emit(
                "ml_target",
                target=target,
                index=target_index,
                total=len(PRICE_COLUMNS),
                detail=f"{target}: no missing values",
            )
            continue
        if len(train_frame) < 10:
            raise ValueError(f"Not enough known values to train the {target} model.")

        emit(
            "ml_target",
            target=target,
            index=target_index,
            total=len(PRICE_COLUMNS),
            detail=(
                f"{target}: training on {len(train_frame):,} known values; "
                f"filling {len(predict_frame):,}"
            ),
        )

        forbidden = ["bgs_10", "cgc_10", "sgc_10"] if target == "psa_10" else []
        allowed = [
            grade for grade in PRICE_COLUMNS
            if grade != target and grade not in forbidden
        ]
        for grade in allowed:
            train_frame[grade] = np.log1p(train_frame[grade])
            predict_frame[grade] = np.log1p(predict_frame[grade])

        features = ["set_name", "card_name", "release_year", *allowed]
        preprocessor = ColumnTransformer(
            transformers=[
                ("set_te", TargetEncoder(random_state=42), ["set_name"]),
                ("card_cv", CountVectorizer(max_features=50, stop_words="english"), "card_name"),
                ("numeric", "passthrough", ["release_year", *allowed]),
            ],
            sparse_threshold=0,
        )
        model = Pipeline(
            [
                ("preprocessor", preprocessor),
                (
                    "regressor",
                    LGBMRegressor(
                        objective="quantile",
                        alpha=0.25,
                        random_state=42,
                        n_jobs=-1,
                        verbose=-1,
                    ),
                ),
            ]
        )
        search = HalvingRandomSearchCV(
            model,
            param_distributions={
                "regressor__learning_rate": [0.05, 0.1, 0.2],
                "regressor__n_estimators": [100, 200, 300],
                "regressor__max_depth": [3, 5, -1],
                "regressor__reg_lambda": [0.0, 0.1, 1.0],
                "regressor__min_child_samples": [20, 50, 100],
            },
            factor=3,
            min_resources=100,
            scoring="neg_mean_absolute_error",
            cv=3,
            random_state=42,
            n_jobs=-1,
        )
        search.fit(train_frame[features], np.log1p(train_frame[target]))
        predictions = np.expm1(search.best_estimator_.predict(predict_frame[features]))
        predictions = np.maximum(predictions, 1.0)
        filled.loc[predict_mask, target] = np.round(predictions, 2)
        working.loc[predict_mask, target] = np.round(predictions, 2)

    return filled, initial_missing


def calculate_z_scores(frame: pd.DataFrame) -> pd.DataFrame:
    result = frame.copy()
    grouped = result.groupby("set_name")["psa_10"]
    means = grouped.transform("mean")
    deviations = grouped.transform("std").replace(0, np.nan)
    result["set_z_score"] = ((result["psa_10"] - means) / deviations).fillna(0).round(2)
    return result


def validate_final(candidate: pd.DataFrame, current_path: Path) -> None:
    current = pd.read_csv(current_path, dtype={"id": "string"})
    candidate_ids = candidate["id"].astype("string").tolist()
    if candidate_ids != current["id"].astype("string").tolist():
        raise ValueError("Final ID membership or order differs from the active dataset.")
    if candidate["set_name"].fillna("").tolist() != current["set_name"].fillna("").tolist():
        raise ValueError("Final set names differ from the active dataset.")
    if candidate["card_name"].fillna("").tolist() != current["card_name"].fillna("").tolist():
        raise ValueError("Final card names differ from the active dataset.")
    if (
        "release_date" in current.columns
        and candidate["release_date"].fillna("").tolist()
        != current["release_date"].fillna("").tolist()
    ):
        raise ValueError("Final release dates differ from the active dataset.")
    invalid = candidate[PRICE_COLUMNS].isna() | (candidate[PRICE_COLUMNS] < 1.0)
    if invalid.any().any():
        raise ValueError("ML output still contains blank or invalid prices.")


def summarize_price_changes(old_values: np.ndarray, new_values: np.ndarray) -> dict:
    valid = np.isfinite(old_values) & np.isfinite(new_values) & (old_values > 0)
    old_values = old_values[valid]
    new_values = new_values[valid]
    percent_change = (new_values / old_values - 1) * 100
    changed_amount = new_values - old_values
    increased = changed_amount > 0.005
    decreased = changed_amount < -0.005
    unchanged = ~(increased | decreased)
    count = len(percent_change)

    return {
        "count": count,
        "increasedCount": int(increased.sum()),
        "increasedSharePct": round(float(increased.mean() * 100), 2),
        "averageIncreasePct": round(
            float(percent_change[increased].mean()) if increased.any() else 0.0, 2
        ),
        "decreasedCount": int(decreased.sum()),
        "decreasedSharePct": round(float(decreased.mean() * 100), 2),
        "averageDecreasePct": round(
            float(-percent_change[decreased].mean()) if decreased.any() else 0.0, 2
        ),
        "unchangedCount": int(unchanged.sum()),
        "unchangedSharePct": round(float(unchanged.mean() * 100), 2),
        "averageChangePct": round(float(percent_change.mean()), 2),
        "medianChangePct": round(float(np.median(percent_change)), 2),
        "totalValueChangePct": round(
            float((new_values.sum() / old_values.sum() - 1) * 100), 2
        ),
    }


def build_price_change_report(candidate: pd.DataFrame, current_path: Path) -> dict:
    current = pd.read_csv(current_path)
    columns = []
    for key, label in REPORT_COLUMNS:
        summary = summarize_price_changes(
            current[key].to_numpy(dtype=float),
            candidate[key].to_numpy(dtype=float),
        )
        columns.append({"key": key, "label": label, **summary})

    keys = [key for key, _ in REPORT_COLUMNS]
    overall = summarize_price_changes(
        current[keys].to_numpy(dtype=float).ravel(),
        candidate[keys].to_numpy(dtype=float).ravel(),
    )
    return {
        "cardCount": len(candidate),
        "priceFieldCount": len(REPORT_COLUMNS),
        "overall": overall,
        "columns": columns,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--download", type=Path, required=True)
    parser.add_argument("--current", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    emit("step_start", step="map")
    mapped = map_and_validate(args.download, args.current)
    emit("step_complete", step="map")

    emit("step_start", step="ml")
    filled, count = fill_missing_prices(mapped)
    filled = calculate_z_scores(filled)
    validate_final(filled, args.current)
    report = build_price_change_report(filled, args.current)
    columns = [*SOURCE_MAPPING.values(), "set_z_score"]
    filled[columns].to_csv(args.output, index=False)
    emit(
        "step_detail",
        step="ml",
        detail=f"Filled {count:,} missing prices and recalculated set Z-scores.",
    )
    emit("step_complete", step="ml")
    emit("price_report", report=report)


if __name__ == "__main__":
    main()
