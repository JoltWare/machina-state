protected DoorLock()
{
    regionActions = new Action?[] { null };
    entryActions = new Action?[] { engageBolt, releaseBolt, sirenOn };
    exitActions = new Action?[] { null, null, sirenOff };
    // source, event, guard, action, target, least common ancestor, trace name
    transitions = new TransitionRow[]
    {
        new TransitionRow(State.Locked, Event.EnterCode, () => isValidCode(EnterCode_code), () => { resetAttempts(EnterCode_code); }, State.Unlocked, State.None, "Locked -> Unlocked"),
        new TransitionRow(State.Locked, Event.EnterCode, () => tooManyAttempts(EnterCode_code), null, State.Alarm, State.None, "Locked -> Alarm"),
        new TransitionRow(State.Locked, Event.EnterCode, null, () => { countFailure(EnterCode_code); }, State.None, State.None, "Locked (internal)"),
        new TransitionRow(State.Unlocked, Event.Lock, null, null, State.Locked, State.None, "Unlocked -> Locked"),
        new TransitionRow(State.Unlocked, Event.Timeout, null, null, State.Locked, State.None, "Unlocked -> Locked"),
        new TransitionRow(State.Alarm, Event.Reset, () => isAdminCode(Reset_code), () => { resetAttempts(Reset_code); }, State.Locked, State.None, "Alarm -> Locked"),
    };
}
