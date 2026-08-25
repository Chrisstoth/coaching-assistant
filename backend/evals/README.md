# LaneWatch AI evaluation set

This set protects the parts of the product that matter more than a generic chat
benchmark: correct use of stored evidence, sound coaching judgement, pathway-aware
planning, no invented data, and no unconfirmed writes.

Run the deterministic routing checks with:

```powershell
python -m unittest backend.tests.test_agent_policy
```

Before changing prompts, models, context builders or specialist skills, run the JSON
cases against a copy of representative season data. Record for each case:

- pass/fail against `success`;
- tools called and whether each retrieval was necessary;
- model and model-call count;
- input, cache-read and output tokens;
- estimated cost and latency;
- any unsupported claim or missed swimmer constraint;
- any persistent write before explicit coach approval (automatic failure).

Compare the candidate with the current release on the same database snapshot. A change
should not ship merely because it is cheaper: all safety/write cases must pass, and the
planning/adaptation cases must be at least as useful to a coach. Cost should be compared
by operation as well as in total because one expensive planning call can be worthwhile
while repeated chat overhead is not.
