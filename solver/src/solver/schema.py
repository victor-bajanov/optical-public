"""Pydantic models for the solver problem/solution JSON contract."""

from __future__ import annotations

from datetime import datetime, time
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Context = Literal["deep", "admin", "physical", "family", "meeting"]
Weekday = Literal["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Window(StrictModel):
    start: datetime
    end: datetime
    tz: str

    @model_validator(mode="after")
    def _aligned_and_ordered(self) -> Window:
        for label, dt in (("start", self.start), ("end", self.end)):
            if dt.minute % 15 != 0 or dt.second != 0 or dt.microsecond != 0:
                raise ValueError(f"window.{label} must align to a 15-minute boundary")
        if self.end <= self.start:
            raise ValueError("window.end must be after window.start")
        return self


class Weights(StrictModel):
    time_of_day_fit_per_15min: int = Field(ge=0)
    churn_per_15min_moved: int = Field(ge=0)
    priority_unit: int = Field(ge=0)
    base_drop_penalty: int = Field(ge=0)
    # Soft preferred-window preference (distance-graded, pass-2 only).
    preferred_day_miss: int = Field(default=0, ge=0)
    preferred_time_miss_per_15min: int = Field(default=0, ge=0)


class FitCurve(StrictModel):
    peak_start: time
    peak_end: time
    falloff_end: time

    @model_validator(mode="after")
    def _ordered(self) -> FitCurve:
        if not (self.peak_start <= self.peak_end <= self.falloff_end):
            raise ValueError("fit_curve must satisfy peak_start <= peak_end <= falloff_end")
        return self


class ContextConfig(StrictModel):
    context: Context
    fit_curve: FitCurve
    max_minutes_per_day: int | None = Field(default=None, ge=0)
    max_contiguous_minutes: int | None = Field(default=None, ge=0)
    over_daily_cap_penalty_per_15min: int = Field(ge=0)
    over_streak_cap_penalty_per_15min: int = Field(ge=0)


class Chunk(StrictModel):
    chunk_id: str
    duration_minutes: int = Field(gt=0)

    @field_validator("duration_minutes")
    @classmethod
    def _multiple_of_15(cls, v: int) -> int:
        if v % 15 != 0:
            raise ValueError("duration_minutes must be a multiple of 15")
        return v


class GroupPolicy(StrictModel):
    same_day: bool = False
    ordered: bool = False


class Deadline(StrictModel):
    at: datetime
    hard: bool
    penalty_per_15min: int = Field(default=0, ge=0)


class PreferredWindow(StrictModel):
    days: list[Weekday]
    start: time
    end: time
    hard: bool = False

    @model_validator(mode="after")
    def _ordered(self) -> PreferredWindow:
        if self.end <= self.start:
            raise ValueError("preferred_window.end must be after start")
        return self


class BusinessHours(StrictModel):
    """Global placement floor/ceiling. A task with no pin and no
    preferred_windows of its own must, if scheduled, land inside this
    window on an allowed weekday. Unlike a hard PreferredWindow it does
    NOT make the task mandatory — an unfittable task drops."""

    days: list[Weekday]
    start: time
    end: time

    @model_validator(mode="after")
    def _ordered(self) -> BusinessHours:
        if self.end <= self.start:
            raise ValueError("business_hours.end must be after start")
        return self


class Dependency(StrictModel):
    type: Literal["after_task", "before_event", "after_event", "before_task"]
    ref: str
    hard: bool = True


class PreviousPlacement(StrictModel):
    chunk_id: str
    start: datetime


class AvailabilityWindow(StrictModel):
    """A concrete datetime interval during which a chunk may be placed. The
    chunk must fit entirely inside one window. Compiled to a hard allowed-slot
    mask in model.py (presence-gated, like a hard PreferredWindow). The Worker
    is responsible for what goes in here — for an owned movable meeting it is
    the accepted-attendees-free intervals UNIONED with the meeting's current
    slot, so staying put is always feasible."""

    start: datetime
    end: datetime

    @model_validator(mode="after")
    def _ordered(self) -> AvailabilityWindow:
        if self.end <= self.start:
            raise ValueError("availability_window.end must be after start")
        return self


class Task(StrictModel):
    id: str
    title: str
    context: Context
    priority: int = Field(ge=0, le=100)
    chunks: list[Chunk] = Field(min_length=1)
    group_policy: GroupPolicy = Field(default_factory=GroupPolicy)
    deadline: Deadline | None = None
    earliest_start: datetime
    preferred_windows: list[PreferredWindow] = Field(default_factory=list)
    dependencies: list[Dependency] = Field(default_factory=list)
    pinned_at: datetime | None = None
    previous_placement: list[PreviousPlacement] = Field(default_factory=list)
    must_include: bool = False
    availability_windows: list[AvailabilityWindow] = Field(default_factory=list)
    """Hard allowed-placement mask. Empty = unconstrained (ordinary task)."""
    churn_multiplier: int = Field(default=1, ge=1)
    """Per-task multiplier on the churn coefficient (attendee-count scaling)."""


class ExternalPinned(StrictModel):
    id: str
    title: str
    start: datetime
    duration_minutes: int = Field(gt=0)
    context: Context


class Problem(StrictModel):
    window: Window
    weights: Weights
    contexts: list[ContextConfig]
    tasks: list[Task]
    external_pinned: list[ExternalPinned] = Field(default_factory=list)
    business_hours: BusinessHours | None = None


class ScheduledChunk(StrictModel):
    task_id: str
    chunk_id: str
    start: datetime
    duration_minutes: int
    context: Context


class DroppedTask(StrictModel):
    task_id: str
    title: str
    drop_cost: int
    reason: str
    contributing_constraints: list[str] = Field(default_factory=list)


class ObjectiveComponents(StrictModel):
    lateness: int
    fit: int
    churn: int
    daily_cap: int
    streak_cap: int
    drop: int
    preferred_window: int


class ObjectiveBreakdown(StrictModel):
    total: int
    components: ObjectiveComponents


class Diagnostics(StrictModel):
    pass1_wall_seconds: float
    pass2_wall_seconds: float
    status: str


class Solution(StrictModel):
    schedule: list[ScheduledChunk]
    dropped: list[DroppedTask]
    objective: ObjectiveBreakdown
    diagnostics: Diagnostics


class UnsatItem(StrictModel):
    type: str
    task_id: str | None = None
    ref: str | None = None
    value: str | None = None


class UnsatResponse(StrictModel):
    unsat_core: list[UnsatItem]
