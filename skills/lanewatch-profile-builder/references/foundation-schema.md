# LaneWatch foundation profile contract

## The nine areas

Physical:

- `aerobic_base`: Ability to hold pace and technique in aerobic work; evidence of endurance strengths or limits.
- `sprint_tendency`: Top-speed and power characteristics, acceleration, and speed drop-off.
- `race_pattern`: Typical pacing, splits, race execution, and where performance changes during a race.
- `fatigue_profile`: Observable signs of fatigue, recovery pattern, and technique or behaviour changes under fatigue.
- `training_response`: Training stimuli that tend to work well or poorly and how adaptation presents.

Psychological:

- `motivation_style`: What engages the swimmer and what tends to reduce engagement.
- `competition_response`: Observable response before and during competition or under race pressure.
- `response_to_hard_training`: Behaviour during genuinely difficult sessions and the support that helps.
- `coachability`: How feedback is received, applied, retained, and revisited.

## Neutral question bank

Select only questions needed for missing areas and adapt the language naturally.

- Aerobic/speed: “Across longer aerobic work and short speed work, what patterns do you consistently see?”
- Race/fatigue: “How do they usually execute races, and what changes first when fatigue arrives?”
- Training response: “Which kinds of training produce the best response, and which tend not to land?”
- Motivation: “What seems to engage them most, and what causes them to switch off?”
- Competition: “How do they behave before and during important races compared with normal training?”
- Hard training: “When a session becomes genuinely difficult, what do they do and what support helps?”
- Coachability: “How do they take feedback, apply changes, and retain them under pressure or fatigue?”

Ask for concrete examples when an answer is broad. “Unknown/not enough evidence yet” is a valid result.

## Canonical JSON

```json
{
  "schema_version": 1,
  "source": "lanewatch-profile-builder",
  "generated_at": "2026-08-25",
  "profiles": [
    {
      "swimmer_name": "Example Swimmer",
      "review_status": "coach_confirmed",
      "physical": {
        "aerobic_base": "Concise coach-reviewed description",
        "sprint_tendency": null,
        "race_pattern": null,
        "fatigue_profile": null,
        "training_response": null
      },
      "psychological": {
        "motivation_style": null,
        "competition_response": null,
        "response_to_hard_training": null,
        "coachability": null
      },
      "notes": "Optional provenance or unresolved questions"
    }
  ]
}
```

Rules:

- `schema_version` must be `1`.
- `swimmer_name` must match the LaneWatch roster name. Do not create new swimmers from this import.
- `review_status` is `draft` or `coach_confirmed`.
- Use strings for supported fields and `null` for unknown fields. Do not use placeholders such as `N/A` or `unknown` as athlete facts.
- Keep each field under 2,500 characters and focused on the named area.
- Keep source/provenance commentary in `notes`, not inside an athlete characteristic.
- The app must preview exact name matches, missing fields, and conflicts before confirmation.
