from sqlalchemy import (
    Column, Integer, String, Float, Boolean, Text, DateTime, Date, ForeignKey, JSON, LargeBinary
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from backend.database import Base
from datetime import date as date_type


# ---------------------------------------------------------------------------
# Swimmer age/year utility functions
# ---------------------------------------------------------------------------

def get_age_at_dec31(dob: date_type) -> int:
    """Age at 31 December of the current year — the swimming age."""
    if not dob:
        return None
    today = date_type.today()
    dec_31 = date_type(today.year, 12, 31)
    return dec_31.year - dob.year - ((dec_31.month, dec_31.day) < (dob.month, dob.day))


def get_age_group(dob: date_type) -> str:
    """
    Compute swimming age group based on age at 31 December of current year.
    Returns age group as string, e.g. "13", "14-15", "16-17", "18+".
    """
    if not dob:
        return None
    today = date_type.today()
    dec_31 = date_type(today.year, 12, 31)
    age_at_dec_31 = dec_31.year - dob.year - (
        (dec_31.month, dec_31.day) < (dob.month, dob.day)
    )

    if age_at_dec_31 < 11:
        return f"{age_at_dec_31}"
    elif age_at_dec_31 == 11 or age_at_dec_31 == 12:
        return f"{age_at_dec_31}"
    elif age_at_dec_31 in (13, 14):
        return "13-14"
    elif age_at_dec_31 in (15, 16):
        return "15-16"
    elif age_at_dec_31 in (17, 18):
        return "17-18"
    else:
        return "18+"


def get_school_year(dob: date_type) -> int:
    """
    Compute UK school year based on age at 1 September of current year.
    Returns school year as integer (e.g. 11 for Year 11, 13 for Year 13).
    Returns None for university age (> 18).
    """
    if not dob:
        return None
    today = date_type.today()
    # UK school year runs Sept 1 to Aug 31
    if today.month < 9:
        school_year_start = today.year
    else:
        school_year_start = today.year + 1

    sep_1 = date_type(school_year_start - 1, 9, 1)
    age_at_sep_1 = sep_1.year - dob.year - (
        (sep_1.month, sep_1.day) < (dob.month, dob.day)
    )

    # UK school years: Reception (age 4), Year 1-11 (ages 5-16), Year 12-13 (ages 17-18)
    # Formula: Year N starts at age (N + 4), so N = age - 4
    school_year = age_at_sep_1 - 4

    if school_year > 13:
        return None  # University age
    return school_year if school_year >= 7 else None  # Return None for primary school


class Swimmer(Base):
    __tablename__ = "swimmers"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False, index=True)
    dob = Column(Date, nullable=True)
    gender = Column(String(1), nullable=True)  # M / F
    squad = Column(String, nullable=True)
    active = Column(Boolean, default=True)
    status = Column(String, default="active")  # active / sabbatical / injury
    swimrankings_id = Column(String, nullable=True, index=True)

    # Coaching profile
    # target_events format: [{"event": "100 Freestyle", "course": "SCM|LCM|Both"}, ...]
    target_events = Column(JSON, default=list)
    course_bias = Column(String, nullable=True)      # "strong_scm" / "slight_scm" / "neutral" / "slight_lcm" / "strong_lcm"
    strengths = Column(Text, nullable=True)
    weaknesses = Column(Text, nullable=True)
    profile_notes = Column(Text, nullable=True)      # raw coach observations

    # AI-synthesised profiles (structured JSON)
    physical_profile = Column(JSON, nullable=True)
    psychological_profile = Column(JSON, nullable=True)

    # Planning cohort assignment
    planning_cohort_id = Column(Integer, ForeignKey("planning_cohorts.id"), nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    times = relationship("SwimTime", back_populates="swimmer", cascade="all, delete-orphan")
    session_entries = relationship("SessionEntry", back_populates="swimmer", cascade="all, delete-orphan")
    meet_targets = relationship("MeetTarget", back_populates="swimmer", cascade="all, delete-orphan")
    meet_entries = relationship("MeetEntry", back_populates="swimmer", cascade="all, delete-orphan")
    pathway_memberships = relationship("PathwayMembership", back_populates="swimmer", cascade="all, delete-orphan")
    qualification_assessments = relationship("QualificationAssessment", back_populates="swimmer", cascade="all, delete-orphan")
    schedules = relationship("Schedule", back_populates="swimmer")
    swimmer_slots = relationship("SwimmerSlot", back_populates="swimmer", cascade="all, delete-orphan")
    exceptions = relationship("SwimmerException", back_populates="swimmer", cascade="all, delete-orphan")
    observations = relationship("SwimmerObservation", back_populates="swimmer", cascade="all, delete-orphan")
    load_events = relationship("SwimmerLoadEvent", back_populates="swimmer", cascade="all, delete-orphan")
    profile_conversations = relationship("ProfileConversation", back_populates="swimmer", cascade="all, delete-orphan")
    training_histories = relationship("TrainingHistoryNarrative", back_populates="swimmer", cascade="all, delete-orphan")
    periodization_plans = relationship("PeriodizationPlan", back_populates="swimmer", cascade="all, delete-orphan")
    analyses = relationship("AIAnalysis", back_populates="swimmer")
    profile_versions = relationship("SwimmerProfileVersion", back_populates="swimmer", cascade="all, delete-orphan")
    benchmarks = relationship("BenchmarkLog", back_populates="swimmer", cascade="all, delete-orphan")
    targets = relationship("SwimmerTarget", back_populates="swimmer", cascade="all, delete-orphan")


class SwimTime(Base):
    __tablename__ = "swim_times"

    id = Column(Integer, primary_key=True, index=True)
    swimmer_id = Column(Integer, ForeignKey("swimmers.id"), nullable=False)

    event = Column(String, nullable=False, index=True)   # "100 Freestyle SCM"
    stroke = Column(String, nullable=True)
    course = Column(String(3), nullable=True)            # SCM / LCM
    distance = Column(Integer, nullable=True)            # metres

    time_seconds = Column(Float, nullable=False)
    wa_points = Column(Float, nullable=True)
    wa_points_age = Column(Float, nullable=True)

    date = Column(Date, nullable=True)
    meet = Column(String, nullable=True)
    venue = Column(String, nullable=True)
    level = Column(String, nullable=True)
    round = Column(String, nullable=True)               # Heat / Final / Semi

    splits = Column(JSON, nullable=True)                 # [split1, split2, ...] seconds
    age_at_swim = Column(Float, nullable=True)
    source = Column(String, default="csv")              # csv / manual

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    swimmer = relationship("Swimmer", back_populates="times")


class TrainingBlock(Base):
    __tablename__ = "training_blocks"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    squad = Column(String, nullable=True)
    date_from = Column(Date, nullable=True)
    date_to = Column(Date, nullable=True)
    block_type = Column(String, nullable=True)          # macro / meso / micro
    focus = Column(Text, nullable=True)
    notes = Column(Text, nullable=True)

    sessions = relationship("Session", back_populates="training_block")


class Session(Base):
    __tablename__ = "sessions"

    id = Column(Integer, primary_key=True, index=True)
    date = Column(Date, nullable=False, index=True)
    squad = Column(String, nullable=True)
    title = Column(String, nullable=True)

    start_time = Column(String, nullable=True)            # "06:00"
    end_time = Column(String, nullable=True)              # "07:30"
    planned_content = Column(JSON, nullable=True)        # {group1: {...}, group2: {...}, group3: {...}}
    source = Column(String, default="manual")           # manual / excel / photo
    coach_notes = Column(Text, nullable=True)
    coach_intent = Column(Text, nullable=True)           # why this session was planned
    energy_system_focus = Column(String, nullable=True) # aerobic / threshold / speed / recovery
    individual_mods = Column(JSON, nullable=True)        # {"swimmer_name": "modification note"}
    # How many distinct programmes were actually run. Null means the coach has
    # not confirmed it yet; 1 means the whole squad completed the same work.
    register_group_count = Column(Integer, nullable=True)

    training_block_id = Column(Integer, ForeignKey("training_blocks.id"), nullable=True)

    course = Column(String(3), nullable=True)               # SCM / LCM

    # Calendar lifecycle
    status = Column(String, default='completed')           # active / cancelled / completed
    pool_slot_id = Column(Integer, ForeignKey("pool_slots.id"), nullable=True)
    cancel_reason = Column(Text, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    training_block = relationship("TrainingBlock", back_populates="sessions")
    pool_slot = relationship("PoolSlot")
    groups = relationship("SessionGroup", back_populates="session", cascade="all, delete-orphan")
    entries = relationship("SessionEntry", back_populates="session", cascade="all, delete-orphan")
    analyses = relationship("AIAnalysis", back_populates="session")


class SessionGroup(Base):
    __tablename__ = "session_groups"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(Integer, ForeignKey("sessions.id"), nullable=False)
    group_number = Column(Integer, nullable=False)       # 1 / 2 / 3
    description = Column(Text, nullable=True)
    sets = Column(JSON, nullable=True)                   # structured set list
    target_swimmer_ids = Column(JSON, default=list)      # [swimmer_id, ...]
    volume_breakdown = Column(JSON, nullable=True)       # {"aerobic": 2400, ...}

    session = relationship("Session", back_populates="groups")
    sub_groups = relationship("SessionSubGroup", back_populates="group", cascade="all, delete-orphan")


class SessionSubGroup(Base):
    __tablename__ = "session_sub_groups"

    id = Column(Integer, primary_key=True, index=True)
    session_group_id = Column(Integer, ForeignKey("session_groups.id"), nullable=False)
    label = Column(String, nullable=False)               # "A", "B", "C"
    aim = Column(Text, nullable=True)                    # "Sprint focus — stroke rate off the wall"
    sets = Column(JSON, nullable=True)                   # ["8x50 @ race pace 1:00", ...]
    swimmer_ids = Column(JSON, default=list)             # [1, 2, 5]
    volume_breakdown = Column(JSON, nullable=True)       # {"aerobic": 2400, "race_pace": 800, ...}

    group = relationship("SessionGroup", back_populates="sub_groups")


class SwimmerSessionLoad(Base):
    __tablename__ = "swimmer_session_loads"

    id = Column(Integer, primary_key=True, index=True)
    swimmer_id = Column(Integer, ForeignKey("swimmers.id"), nullable=False)
    session_id = Column(Integer, ForeignKey("sessions.id"), nullable=False)
    session_date = Column(Date, nullable=False)
    group_number = Column(Integer, nullable=True)
    sub_group_label = Column(String, nullable=True)
    volume_breakdown = Column(JSON, nullable=True)       # {"aerobic": 2400, ...}
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class SessionEntry(Base):
    __tablename__ = "session_entries"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(Integer, ForeignKey("sessions.id"), nullable=False)
    swimmer_id = Column(Integer, ForeignKey("swimmers.id"), nullable=False)

    attended = Column(Boolean, nullable=True)
    group_planned = Column(Integer, nullable=True)       # 1 / 2 / 3 — from session plan
    sub_group_planned = Column(String, nullable=True)    # "A" / "B" — from session plan
    group_done = Column(Integer, nullable=True)          # 1 / 2 / 3 — actual on the day
    sub_group_done = Column(String, nullable=True)       # "A" / "B" — actual on the day
    sets_completed = Column(JSON, nullable=True)
    coach_observation = Column(Text, nullable=True)

    ai_characterisation = Column(Text, nullable=True)   # Claude's read on how this swimmer did
    ai_expected_response = Column(Text, nullable=True)  # what adaptation is expected

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    session = relationship("Session", back_populates="entries")
    swimmer = relationship("Swimmer", back_populates="session_entries")


class Meet(Base):
    __tablename__ = "meets"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    date = Column(Date, nullable=True)               # start date
    date_to = Column(Date, nullable=True)            # end date (multi-day)
    location = Column(String, nullable=True)
    course = Column(String(3), nullable=True)        # SCM / LCM
    level = Column(String, nullable=True)            # club / regional / national / international
    warm_up_time = Column(String, nullable=True)     # "07:30"
    notes = Column(Text, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    targets = relationship("MeetTarget", back_populates="meet", cascade="all, delete-orphan")
    timetable_sessions = relationship(
        "MeetSession", back_populates="meet", cascade="all, delete-orphan",
        order_by="MeetSession.order_index",
    )
    timetable_events = relationship("MeetEvent", back_populates="meet", cascade="all, delete-orphan")
    entries = relationship("MeetEntry", back_populates="meet", cascade="all, delete-orphan")
    qualification_sets = relationship("QualificationStandardSet", back_populates="meet", cascade="all, delete-orphan")


class MeetTarget(Base):
    __tablename__ = "meet_targets"

    id = Column(Integer, primary_key=True, index=True)
    meet_id = Column(Integer, ForeignKey("meets.id"), nullable=False)
    swimmer_id = Column(Integer, ForeignKey("swimmers.id"), nullable=False)
    events = Column(JSON, default=list)              # ["100 Freestyle", ...]
    priority = Column(String(1), nullable=True)      # A / B / C
    target_times = Column(JSON, nullable=True)       # {"100 Freestyle": "52.50"}
    notes = Column(Text, nullable=True)

    meet = relationship("Meet", back_populates="targets")
    swimmer = relationship("Swimmer", back_populates="meet_targets")


class MeetSession(Base):
    """One competition session within a meet, including its ordered event programme."""
    __tablename__ = "meet_sessions"

    id = Column(Integer, primary_key=True, index=True)
    meet_id = Column(Integer, ForeignKey("meets.id"), nullable=False, index=True)
    name = Column(String, nullable=False)                 # e.g. Saturday AM
    date = Column(Date, nullable=True)
    warm_up_time = Column(String, nullable=True)
    start_time = Column(String, nullable=True)
    end_time = Column(String, nullable=True)
    order_index = Column(Integer, default=0)
    events = Column(JSON, default=list)                  # [{number, name, start_time?}, ...]
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    meet = relationship("Meet", back_populates="timetable_sessions")
    normalized_events = relationship(
        "MeetEvent", back_populates="meet_session", cascade="all, delete-orphan",
        order_by="MeetEvent.order_index",
    )


class MeetEvent(Base):
    """A canonical, addressable competition event extracted from a timetable session."""
    __tablename__ = "meet_events"

    id = Column(Integer, primary_key=True, index=True)
    meet_id = Column(Integer, ForeignKey("meets.id"), nullable=False, index=True)
    meet_session_id = Column(Integer, ForeignKey("meet_sessions.id"), nullable=False, index=True)
    event_number = Column(String, nullable=True)
    name = Column(String, nullable=False)
    canonical_event = Column(String, nullable=False, index=True)
    distance = Column(Integer, nullable=True)
    stroke = Column(String, nullable=True)
    gender = Column(String, nullable=True)
    round = Column(String, nullable=True)
    scheduled_time = Column(String, nullable=True)
    order_index = Column(Integer, default=0)
    raw_data = Column(JSON, nullable=True)

    meet = relationship("Meet", back_populates="timetable_events")
    meet_session = relationship("MeetSession", back_populates="normalized_events")
    entries = relationship("MeetEntry", back_populates="meet_event")


class MeetEntry(Base):
    """An explicit swimmer-to-competition-event link, independent of text matching at prompt time."""
    __tablename__ = "meet_entries"

    id = Column(Integer, primary_key=True, index=True)
    meet_id = Column(Integer, ForeignKey("meets.id"), nullable=False, index=True)
    meet_event_id = Column(Integer, ForeignKey("meet_events.id"), nullable=True, index=True)
    swimmer_id = Column(Integer, ForeignKey("swimmers.id"), nullable=False, index=True)
    event_name = Column(String, nullable=False)
    canonical_event = Column(String, nullable=False, index=True)
    entry_time = Column(String, nullable=True)
    target_time = Column(String, nullable=True)
    priority = Column(String(1), nullable=True)
    status = Column(String, default="confirmed")
    source = Column(String, default="manual")
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    meet = relationship("Meet", back_populates="entries")
    meet_event = relationship("MeetEvent", back_populates="entries")
    swimmer = relationship("Swimmer", back_populates="meet_entries")


class QualificationStandardSet(Base):
    """A source document and its reviewed competition-entry rules."""
    __tablename__ = "qualification_standard_sets"

    id = Column(Integer, primary_key=True, index=True)
    meet_id = Column(Integer, ForeignKey("meets.id"), nullable=True, index=True)
    name = Column(String, nullable=False)
    organiser = Column(String, nullable=True)
    season_label = Column(String, nullable=True)
    status = Column(String, default="draft")       # draft / confirmed / archived
    rules = Column(JSON, default=dict)
    source_filename = Column(String, nullable=True)
    source_mime_type = Column(String, nullable=True)
    source_sha256 = Column(String, nullable=True, index=True)
    source_document = Column(LargeBinary, nullable=True)
    extraction_model = Column(String, nullable=True)
    extraction_notes = Column(JSON, default=list)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    confirmed_at = Column(DateTime(timezone=True), nullable=True)

    meet = relationship("Meet", back_populates="qualification_sets")
    standards = relationship("QualificationStandard", back_populates="standard_set", cascade="all, delete-orphan")
    assessments = relationship("QualificationAssessment", back_populates="standard_set", cascade="all, delete-orphan")


class QualificationStandard(Base):
    """One comparable event/gender/age/course threshold from a standards document."""
    __tablename__ = "qualification_standards"

    id = Column(Integer, primary_key=True, index=True)
    standard_set_id = Column(Integer, ForeignKey("qualification_standard_sets.id"), nullable=False, index=True)
    event_name = Column(String, nullable=False)
    canonical_event = Column(String, nullable=False, index=True)
    distance = Column(Integer, nullable=True)
    stroke = Column(String, nullable=True)
    gender = Column(String, nullable=True)          # female / male_open / open
    age_label = Column(String, nullable=True)
    age_min = Column(Integer, nullable=True)
    age_max = Column(Integer, nullable=True)
    course = Column(String(3), nullable=False)      # SCM / LCM
    standard_type = Column(String, nullable=False)  # qualifying / automatic / base / consideration
    time_seconds = Column(Float, nullable=False)
    time_display = Column(String, nullable=True)
    source_page = Column(Integer, nullable=True)
    raw_data = Column(JSON, nullable=True)

    standard_set = relationship("QualificationStandardSet", back_populates="standards")
    assessments = relationship("QualificationAssessment", back_populates="standard", cascade="all, delete-orphan")


class QualificationAssessment(Base):
    """Persisted result of comparing one swimmer with one qualification standard."""
    __tablename__ = "qualification_assessments"

    id = Column(Integer, primary_key=True, index=True)
    standard_set_id = Column(Integer, ForeignKey("qualification_standard_sets.id"), nullable=False, index=True)
    standard_id = Column(Integer, ForeignKey("qualification_standards.id"), nullable=False, index=True)
    swimmer_id = Column(Integer, ForeignKey("swimmers.id"), nullable=False, index=True)
    best_time_id = Column(Integer, ForeignKey("swim_times.id"), nullable=True)
    status = Column(String, nullable=False)          # achieved / chasing / outside / no_time / conversion_required
    best_time_seconds = Column(Float, nullable=True)
    gap_seconds = Column(Float, nullable=True)
    gap_percent = Column(Float, nullable=True)
    eligibility_reason = Column(Text, nullable=True)
    source_hash = Column(String, nullable=True, index=True)
    calculated_at = Column(DateTime(timezone=True), server_default=func.now())

    standard_set = relationship("QualificationStandardSet", back_populates="assessments")
    standard = relationship("QualificationStandard", back_populates="assessments")
    swimmer = relationship("Swimmer", back_populates="qualification_assessments")
    best_time = relationship("SwimTime")


class PoolSlot(Base):
    """A recurring session in the pool timetable — e.g. Mon 06:00 Senior."""
    __tablename__ = "pool_slots"

    id = Column(Integer, primary_key=True, index=True)
    day_of_week = Column(Integer, nullable=False)        # 0=Mon ... 6=Sun
    time = Column(String, nullable=False)                # "06:00"
    end_time = Column(String, nullable=True)             # "07:30"
    squad = Column(String, nullable=True)
    label = Column(String, nullable=True)
    active = Column(Boolean, default=True)

    # Pool conditions for this slot
    course = Column(String(3), nullable=True)            # SCM / LCM
    lanes = Column(Integer, nullable=True)               # number of lanes available
    has_blocks = Column(Boolean, default=False)          # starting blocks available
    pool_config = Column(String, nullable=True)          # full_pool / deep_end / shallow_end
    alternate_ends = Column(Boolean, default=False)      # flips deep↔shallow each ISO week

    swimmer_slots = relationship("SwimmerSlot", back_populates="pool_slot", cascade="all, delete-orphan")


class SwimmerSlot(Base):
    """Records that a swimmer normally attends a given pool slot."""
    __tablename__ = "swimmer_slots"

    id = Column(Integer, primary_key=True, index=True)
    swimmer_id = Column(Integer, ForeignKey("swimmers.id"), nullable=False)
    pool_slot_id = Column(Integer, ForeignKey("pool_slots.id"), nullable=False)

    swimmer = relationship("Swimmer", back_populates="swimmer_slots")
    pool_slot = relationship("PoolSlot", back_populates="swimmer_slots")


class SwimmerException(Base):
    """Temporary override — holiday, exams, work, etc. — for a date range."""
    __tablename__ = "swimmer_exceptions"

    id = Column(Integer, primary_key=True, index=True)
    swimmer_id = Column(Integer, ForeignKey("swimmers.id"), nullable=False)
    reason = Column(String, nullable=False)              # holiday / exams / work / injury / other
    date_from = Column(Date, nullable=False)
    date_to = Column(Date, nullable=False)
    notes = Column(Text, nullable=True)

    swimmer = relationship("Swimmer", back_populates="exceptions")


class Schedule(Base):
    __tablename__ = "schedules"

    id = Column(Integer, primary_key=True, index=True)
    swimmer_id = Column(Integer, ForeignKey("swimmers.id"), nullable=False)
    day_of_week = Column(Integer, nullable=True)         # 0=Mon ... 6=Sun
    session_time = Column(String, nullable=True)         # "06:00", "18:00"
    status = Column(String, default="regular")           # regular / holiday / exams / work / other
    notes = Column(Text, nullable=True)
    date_from = Column(Date, nullable=True)
    date_to = Column(Date, nullable=True)

    swimmer = relationship("Swimmer", back_populates="schedules")


class PeriodizationPlan(Base):
    __tablename__ = "periodization_plans"

    id = Column(Integer, primary_key=True, index=True)
    swimmer_id = Column(Integer, ForeignKey("swimmers.id"), nullable=False)
    plan_type = Column(String, nullable=False)           # macro / meso / micro
    date_from = Column(Date, nullable=True)
    date_to = Column(Date, nullable=True)
    focus = Column(Text, nullable=True)
    content = Column(JSON, nullable=True)
    ai_generated = Column(Boolean, default=True)
    coach_approved = Column(Boolean, default=False)
    rationale = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    swimmer = relationship("Swimmer", back_populates="periodization_plans")


class SwimmerObservation(Base):
    """
    A coach observation about a swimmer — race, training response, physical marker, general.
    These accumulate over time and are the raw material the AI uses to model the swimmer.
    """
    __tablename__ = "swimmer_observations"

    id = Column(Integer, primary_key=True, index=True)
    swimmer_id = Column(Integer, ForeignKey("swimmers.id"), nullable=False)
    session_id = Column(Integer, ForeignKey("sessions.id"), nullable=True)

    obs_type = Column(String, nullable=False)
    # race / aerobic / threshold / vo2 / speed / recovery / physical / general

    date = Column(Date, nullable=True)
    event = Column(String, nullable=True)        # e.g. "100 Freestyle" — for race obs
    energy_zone = Column(String, nullable=True)  # for training obs

    content = Column(Text, nullable=False)       # free text from coach

    # Optional structured data (stored as JSON so we can add fields over time)
    structured = Column(JSON, nullable=True)
    # e.g. {"hr_range": "140-155", "rep_times": ["1:18.2","1:19.1","1:21.4"],
    #        "recovery": "good", "pacing": "positive split", "technical_notes": "..."}

    ai_summary = Column(Text, nullable=True)     # AI interpretation of this observation

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    swimmer = relationship("Swimmer", back_populates="observations")
    session = relationship("Session")


class SwimmerLoadEvent(Base):
    """
    A significant event that affects a swimmer's training load or readiness —
    competitions, illness, injury, travel, camps, double-session blocks, etc.
    Used alongside session history and exceptions to model current fatigue state.
    """
    __tablename__ = "swimmer_load_events"

    id = Column(Integer, primary_key=True, index=True)
    swimmer_id = Column(Integer, ForeignKey("swimmers.id"), nullable=False)

    event_type = Column(String, nullable=False)
    # competition / illness / injury / travel / camp / extra_load / other

    date_from = Column(Date, nullable=False)
    date_to = Column(Date, nullable=True)          # null = single day or ongoing
    severity = Column(Integer, default=2)          # 1=mild  2=moderate  3=significant
    description = Column(Text, nullable=True)      # what happened
    resolved = Column(Boolean, default=True)       # False if still ongoing

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    swimmer = relationship("Swimmer", back_populates="load_events")


class SwimmerProfileVersion(Base):
    """
    Versioned snapshot of a swimmer's race or training profile, synthesised from observations.
    A new row is created each time synthesis runs — never overwritten — so the AI can
    compare versions and identify how the swimmer's characteristics are changing over time.
    """
    __tablename__ = "swimmer_profile_versions"

    id = Column(Integer, primary_key=True, index=True)
    swimmer_id = Column(Integer, ForeignKey("swimmers.id"), nullable=False)
    profile_type = Column(String, nullable=False)   # 'race' | 'training'
    data = Column(JSON, nullable=False)             # the profile fields
    change_summary = Column(Text, nullable=True)    # AI-generated delta from previous version
    obs_count = Column(Integer, nullable=True)      # number of observations used
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    swimmer = relationship("Swimmer", back_populates="profile_versions")


class TrainingHistoryNarrative(Base):
    __tablename__ = "training_history_narratives"

    id = Column(Integer, primary_key=True, index=True)
    swimmer_id = Column(Integer, ForeignKey("swimmers.id"), nullable=False)
    narrative = Column(Text, nullable=False)
    source = Column(String, default="reconstructed")     # reconstructed / imported
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    swimmer = relationship("Swimmer", back_populates="training_histories")


class BenchmarkLog(Base):
    """
    A logged training benchmark for a swimmer — best effort times at specific
    distances/strokes/effort levels observed during training. Accumulates over time;
    the most recent entry per category is the current benchmark.
    """
    __tablename__ = "benchmark_logs"

    id = Column(Integer, primary_key=True, index=True)
    swimmer_id = Column(Integer, ForeignKey("swimmers.id"), nullable=False)
    session_id = Column(Integer, ForeignKey("sessions.id"), nullable=True)

    distance = Column(Integer, nullable=False)       # 25 / 50 / 100 / 200
    stroke = Column(String, nullable=False)          # free / back / breast / fly
    effort = Column(String, nullable=False)          # max / aerobic / threshold
    time_seconds = Column(Float, nullable=False)
    notes = Column(Text, nullable=True)
    date = Column(Date, nullable=False)

    logged_by = Column(String, default="coach")     # coach / ai
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    swimmer = relationship("Swimmer", back_populates="benchmarks")
    session = relationship("Session")


class SwimmerTarget(Base):
    """
    A coach-set performance target for a swimmer. Can be a benchmark target
    (e.g. hit 1:04 aerobic 100 free by Christmas) or a freeform goal.
    Tracked against BenchmarkLog entries over time.
    """
    __tablename__ = "swimmer_targets"

    id = Column(Integer, primary_key=True, index=True)
    swimmer_id = Column(Integer, ForeignKey("swimmers.id"), nullable=False)

    label = Column(String, nullable=False)           # e.g. "Aerobic 100 free target"
    description = Column(Text, nullable=True)        # freeform context / rationale

    # Optional: link to a specific benchmark category
    distance = Column(Integer, nullable=True)
    stroke = Column(String, nullable=True)
    effort = Column(String, nullable=True)
    target_time_seconds = Column(Float, nullable=True)

    deadline = Column(Date, nullable=True)
    achieved = Column(Boolean, default=False)
    achieved_date = Column(Date, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    swimmer = relationship("Swimmer", back_populates="targets")


class AIAnalysis(Base):
    __tablename__ = "ai_analyses"

    id = Column(Integer, primary_key=True, index=True)
    swimmer_id = Column(Integer, ForeignKey("swimmers.id"), nullable=False)
    session_id = Column(Integer, ForeignKey("sessions.id"), nullable=True)
    analysis_type = Column(String, nullable=False)       # session_response / adaptation / profile / periodization
    content = Column(Text, nullable=False)
    model_used = Column(String, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    swimmer = relationship("Swimmer", back_populates="analyses")
    session = relationship("Session", back_populates="analyses")


class AIUsageLog(Base):
    """Token-only usage telemetry. No prompts or swimmer data are stored here."""
    __tablename__ = "ai_usage_logs"

    id = Column(Integer, primary_key=True, index=True)
    provider = Column(String, nullable=False)
    model = Column(String, nullable=False)
    operation = Column(String, nullable=True)
    input_tokens = Column(Integer, default=0)
    output_tokens = Column(Integer, default=0)
    cache_read_tokens = Column(Integer, default=0)
    cache_write_tokens = Column(Integer, default=0)
    estimated_cost_usd = Column(Float, default=0.0)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)


class SkillOutput(Base):
    """Saved output from a specialist AI skill run — enables history view and audit."""
    __tablename__ = "skill_outputs"

    id = Column(Integer, primary_key=True, index=True)
    skill_type = Column(String, nullable=False)   # adaptation_review / block_review / race_analysis / meso_plan / session_plan / taper_plan
    swimmer_id = Column(Integer, ForeignKey("swimmers.id"), nullable=True)
    entity_type = Column(String, nullable=True)   # swimmer / block / meet / squad / session
    entity_id = Column(Integer, nullable=True)
    entity_name = Column(String, nullable=True)
    full_output = Column(Text, nullable=False)
    brief_output = Column(Text, nullable=True)
    thread_id = Column(Integer, ForeignKey("ai_threads.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class ProfileConversation(Base):
    __tablename__ = "profile_conversations"

    id = Column(Integer, primary_key=True, index=True)
    swimmer_id = Column(Integer, ForeignKey("swimmers.id"), nullable=False)
    role = Column(String, nullable=False)                # coach / ai
    message = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    swimmer = relationship("Swimmer", back_populates="profile_conversations")


class ProfileWizardDraft(Base):
    """Recoverable, unconfirmed transcript for the foundation interview."""
    __tablename__ = "profile_wizard_drafts"

    id = Column(Integer, primary_key=True, index=True)
    swimmer_id = Column(Integer, ForeignKey("swimmers.id"), nullable=False, unique=True, index=True)
    messages = Column(JSON, nullable=False, default=list)
    awaiting_reply = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


# ---------------------------------------------------------------------------
# Coaching context — coach's philosophy, squad state, targets
# ---------------------------------------------------------------------------

class CoachingProfile(Base):
    """
    A finalized snapshot of the coaching context at a point in time.
    Multiple versions are kept historically; one is marked is_current.
    """
    __tablename__ = "coaching_profiles"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, nullable=False)               # e.g. "Season Start 2025-26"
    summary = Column(Text, nullable=False)               # full AI-synthesised narrative
    ethos = Column(Text, nullable=True)                  # coaching philosophy
    squad_state = Column(Text, nullable=True)            # where the group is right now
    targets = Column(Text, nullable=True)                # season/meet targets
    current_focus = Column(Text, nullable=True)          # current training block focus
    is_current = Column(Boolean, default=False)          # only one can be current
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    conversations = relationship("CoachingConversation", back_populates="profile", cascade="all, delete-orphan")


class CoachingConversation(Base):
    """
    A chat message in the conversation that builds or updates a coaching profile.
    profile_id is NULL while a conversation is in progress (not yet finalised).
    """
    __tablename__ = "coaching_conversations"

    id = Column(Integer, primary_key=True, index=True)
    role = Column(String, nullable=False)                # coach / ai
    message = Column(Text, nullable=False)
    profile_id = Column(Integer, ForeignKey("coaching_profiles.id"), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    profile = relationship("CoachingProfile", back_populates="conversations")


# ---------------------------------------------------------------------------
# Coach AI chat — open-ended assistant conversation
# ---------------------------------------------------------------------------

class AIThread(Base):
    """A named conversation thread in the coach AI chat. Multiple threads allow parallel conversations."""
    __tablename__ = "ai_threads"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=True)
    thread_type = Column(String, default="general")   # general | season_plan
    macro_id = Column(Integer, ForeignKey("training_macros.id"), nullable=True)
    rolling_summary = Column(Text, nullable=True)
    summarized_through_message_id = Column(Integer, nullable=True)
    summary_updated_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    messages = relationship("CoachAIMessage", back_populates="thread", cascade="all, delete-orphan")


class CoachAIMessage(Base):
    """
    A message in the coach's general AI chat.
    Persisted so the conversation continues across sessions.
    """
    __tablename__ = "coach_ai_messages"

    id = Column(Integer, primary_key=True, index=True)
    role = Column(String, nullable=False)                # user / assistant
    message = Column(Text, nullable=False)
    thread_id = Column(Integer, ForeignKey("ai_threads.id"), nullable=True, index=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    thread = relationship("AIThread", back_populates="messages")


class CoachingNote(Base):
    """
    A temporary coaching note pinned to a date range.
    Created from an AI chat conversation to inform session planning for a specific period.
    Does not affect swimmer profiles — expires naturally when date_to passes.
    """
    __tablename__ = "coaching_notes"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, nullable=False)
    body = Column(Text, nullable=False)                    # AI-summarised plan
    swimmer_ids = Column(JSON, default=list)               # list of swimmer IDs this applies to
    swimmer_names = Column(JSON, default=list)             # denormalised for display
    date_from = Column(Date, nullable=False)
    date_to = Column(Date, nullable=False)
    active = Column(Boolean, default=True)                 # can be manually closed early
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class Season(Base):
    """A coaching season containing multiple competition-led macrocycles."""
    __tablename__ = "seasons"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    squad = Column(String, nullable=True)
    date_from = Column(Date, nullable=False)
    date_to = Column(Date, nullable=False)
    narrative = Column(Text, nullable=True)
    is_current = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    macros = relationship("TrainingMacro", back_populates="season")


class TrainingMacro(Base):
    __tablename__ = "training_macros"
    id = Column(Integer, primary_key=True, index=True)
    season_id = Column(Integer, ForeignKey("seasons.id"), nullable=True, index=True)
    primary_meet_id = Column(Integer, ForeignKey("meets.id"), nullable=True)
    sequence_index = Column(Integer, default=0)
    name = Column(String, nullable=False)
    squad = Column(String, nullable=True)
    date_from = Column(Date, nullable=False)
    date_to = Column(Date, nullable=False)
    narrative = Column(Text, nullable=True)       # overall season narrative / intent
    group_definitions = Column(JSON, nullable=True)  # {G1: {description: "...", swimmer_ids: [...]}, ...}
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    season = relationship("Season", back_populates="macros")
    primary_meet = relationship("Meet")
    mesos = relationship("SeasonBlock", back_populates="macro", cascade="all, delete-orphan")
    microcycles = relationship("Microcycle", back_populates="macro", cascade="all, delete-orphan")
    pathways = relationship("PlanningPathway", back_populates="macro", cascade="all, delete-orphan")
    planning_snapshots = relationship("PlanningSnapshot", back_populates="macro", cascade="all, delete-orphan")


class SeasonBlock(Base):
    __tablename__ = "season_blocks"
    id = Column(Integer, primary_key=True, index=True)
    macro_id = Column(Integer, ForeignKey("training_macros.id"), nullable=True)
    name = Column(String, nullable=False)
    squad = Column(String, nullable=True)
    phase_type = Column(String, nullable=True)  # base / build / peak / taper / competition / recovery / transition
    date_from = Column(Date, nullable=False)
    date_to = Column(Date, nullable=False)
    emphasis = Column(JSON, nullable=True)
    group_intents = Column(JSON, nullable=True)  # {G1: "build aerobic base...", G2: "...", G3: "..."}
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    macro = relationship("TrainingMacro", back_populates="mesos")
    microcycles = relationship("Microcycle", back_populates="block", cascade="all, delete-orphan")


class Microcycle(Base):
    """A persisted weekly plan connecting a mesocycle to its planned sessions."""
    __tablename__ = "microcycles"

    id = Column(Integer, primary_key=True, index=True)
    macro_id = Column(Integer, ForeignKey("training_macros.id"), nullable=True, index=True)
    block_id = Column(Integer, ForeignKey("season_blocks.id"), nullable=True, index=True)
    squad = Column(String, nullable=True)
    week_start = Column(Date, nullable=False, index=True)
    week_end = Column(Date, nullable=False)
    label = Column(String, nullable=False)
    meso_position_note = Column(Text, nullable=True)
    progression_note = Column(Text, nullable=True)
    recovery_placement = Column(Text, nullable=True)
    next_week_direction = Column(Text, nullable=True)
    coach_flags = Column(JSON, default=list)
    sessions = Column(JSON, default=list)
    status = Column(String, default="draft")            # draft / confirmed / completed
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    macro = relationship("TrainingMacro", back_populates="microcycles")
    block = relationship("SeasonBlock", back_populates="microcycles")


class PlanningCohort(Base):
    __tablename__ = "planning_cohorts"
    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    colour = Column(String, nullable=True)        # e.g. "teal", "orange", "blue", "purple"
    goals = Column(Text, nullable=True)           # free-text development goals
    target_meet_ids = Column(JSON, nullable=True) # [meet_id, ...]
    created_at = Column(DateTime(timezone=True), server_default=func.now())


class PlanningPathway(Base):
    """A macrocycle-specific route through the shared squad programme."""
    __tablename__ = "planning_pathways"

    id = Column(Integer, primary_key=True, index=True)
    macro_id = Column(Integer, ForeignKey("training_macros.id"), nullable=False, index=True)
    name = Column(String, nullable=False)
    colour = Column(String, default="teal")
    objective = Column(Text, nullable=True)
    primary_meet_id = Column(Integer, ForeignKey("meets.id"), nullable=True)
    qualifier_meet_ids = Column(JSON, default=list)
    fallback_meet_id = Column(Integer, ForeignKey("meets.id"), nullable=True)
    qualification_standard_set_id = Column(Integer, ForeignKey("qualification_standard_sets.id"), nullable=True)
    phase_config = Column(JSON, nullable=True)
    active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    macro = relationship("TrainingMacro", back_populates="pathways")
    primary_meet = relationship("Meet", foreign_keys=[primary_meet_id])
    fallback_meet = relationship("Meet", foreign_keys=[fallback_meet_id])
    qualification_standard_set = relationship("QualificationStandardSet")
    memberships = relationship("PathwayMembership", back_populates="pathway", cascade="all, delete-orphan")
    snapshots = relationship("PlanningSnapshot", back_populates="pathway", cascade="all, delete-orphan")


class PathwayMembership(Base):
    __tablename__ = "pathway_memberships"

    id = Column(Integer, primary_key=True, index=True)
    pathway_id = Column(Integer, ForeignKey("planning_pathways.id"), nullable=False, index=True)
    swimmer_id = Column(Integer, ForeignKey("swimmers.id"), nullable=False, index=True)
    date_from = Column(Date, nullable=True)
    date_to = Column(Date, nullable=True)
    qualification_status = Column(String, default="unknown")
    notes = Column(Text, nullable=True)
    active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    pathway = relationship("PlanningPathway", back_populates="memberships")
    swimmer = relationship("Swimmer", back_populates="pathway_memberships")


class PlanningSnapshot(Base):
    """Cached deterministic preparation state supplied to AI instead of raw histories."""
    __tablename__ = "planning_snapshots"

    id = Column(Integer, primary_key=True, index=True)
    macro_id = Column(Integer, ForeignKey("training_macros.id"), nullable=False, index=True)
    pathway_id = Column(Integer, ForeignKey("planning_pathways.id"), nullable=False, index=True)
    swimmer_id = Column(Integer, ForeignKey("swimmers.id"), nullable=False, index=True)
    as_of_date = Column(Date, nullable=False, index=True)
    target_meet_id = Column(Integer, ForeignKey("meets.id"), nullable=True)
    target_date = Column(Date, nullable=True)
    weeks_to_target = Column(Float, nullable=True)
    current_phase = Column(String, nullable=True)
    race_specific_start = Column(Date, nullable=True)
    taper_start = Column(Date, nullable=True)
    load_multiplier = Column(Float, default=1.0)
    qualification_status = Column(String, nullable=True)
    event_summary = Column(JSON, default=list)
    flags = Column(JSON, default=list)
    source_hash = Column(String, nullable=True, index=True)
    generated_at = Column(DateTime(timezone=True), server_default=func.now())

    macro = relationship("TrainingMacro", back_populates="planning_snapshots")
    pathway = relationship("PlanningPathway", back_populates="snapshots")
    swimmer = relationship("Swimmer")
    target_meet = relationship("Meet")


class PlanningRecommendation(Base):
    """Persistent assistant-inbox item backed by deterministic planning evidence."""
    __tablename__ = "planning_recommendations"

    id = Column(Integer, primary_key=True, index=True)
    macro_id = Column(Integer, ForeignKey("training_macros.id"), nullable=True, index=True)
    pathway_id = Column(Integer, ForeignKey("planning_pathways.id"), nullable=True, index=True)
    swimmer_id = Column(Integer, ForeignKey("swimmers.id"), nullable=True, index=True)
    kind = Column(String, nullable=False)
    severity = Column(String, default="info")
    title = Column(String, nullable=False)
    detail = Column(Text, nullable=False)
    evidence = Column(JSON, nullable=True)
    proposed_action = Column(JSON, nullable=True)
    fingerprint = Column(String, nullable=False, index=True)
    status = Column(String, default="open")
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=True)
    last_seen_at = Column(DateTime(timezone=True), nullable=True)
    follow_up_at = Column(DateTime(timezone=True), nullable=True, index=True)
    accepted_at = Column(DateTime(timezone=True), nullable=True)
    actioned_at = Column(DateTime(timezone=True), nullable=True)
    resolved_at = Column(DateTime(timezone=True), nullable=True)
    occurrence_count = Column(Integer, default=1)
    coach_note = Column(Text, nullable=True)
    discussion_thread_id = Column(Integer, ForeignKey("ai_threads.id"), nullable=True)

    events = relationship(
        "PlanningRecommendationEvent",
        back_populates="recommendation",
        cascade="all, delete-orphan",
        order_by="PlanningRecommendationEvent.created_at",
    )
    discussion_thread = relationship("AIThread", foreign_keys=[discussion_thread_id])


class PlanningRecommendationEvent(Base):
    """Audit trail for inbox decisions and automatic follow-up transitions."""
    __tablename__ = "planning_recommendation_events"

    id = Column(Integer, primary_key=True, index=True)
    recommendation_id = Column(
        Integer,
        ForeignKey("planning_recommendations.id"),
        nullable=False,
        index=True,
    )
    event_type = Column(String, nullable=False)
    detail = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    recommendation = relationship("PlanningRecommendation", back_populates="events")
