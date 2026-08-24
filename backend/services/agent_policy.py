"""Pure routing policy for the conversational coaching agent.

The policy is deliberately deterministic so choosing a cheaper model never costs
an extra model call. Specialist planning routes are selected earlier by ai_chat.
"""
from __future__ import annotations

from dataclasses import dataclass


COMPLEX_SIGNALS = (
    "analyse", "analyze", "analysis", "assess", "compare", "design", "explain why",
    "how should", "plan", "periodisation", "periodization", "recommend", "review",
    "should we", "strategy", "taper", "trade-off", "tradeoff", "what do you think",
    "why has", "why is", "work through",
)

FACTUAL_SIGNALS = (
    "when is", "what date", "what time", "who is", "which swimmers", "show me",
    "list", "how many", "what was", "did we", "is there", "are there",
)


@dataclass(frozen=True)
class AgentRoute:
    tier: str
    reason: str


def choose_agent_route(message: str, topics: set[str], thread_type: str | None = None) -> AgentRoute:
    """Choose primary or fast without calling a model.

    Season/athlete planning threads always retain the primary model. Short factual
    retrieval can use the fast model even when it mentions a meet or swimmer.
    """
    text = " ".join((message or "").lower().split())
    words = text.split()
    if thread_type in {"season_plan", "athlete_planning"}:
        return AgentRoute("primary", "planning_thread")
    if any(signal in text for signal in COMPLEX_SIGNALS):
        return AgentRoute("primary", "complex_reasoning_signal")
    if len(words) <= 24 and any(signal in text for signal in FACTUAL_SIGNALS):
        return AgentRoute("fast", "short_factual_retrieval")
    if "planning" in topics or "session_writing" in topics:
        return AgentRoute("primary", "planning_topic")
    if len(words) <= 12 and not topics.intersection({"biological", "performance", "coaching_intent"}):
        return AgentRoute("fast", "short_general_request")
    return AgentRoute("primary", "coaching_judgement_default")
