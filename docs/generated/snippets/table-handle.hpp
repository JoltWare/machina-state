bool HandleEvent(State state, Event event) {
    for (const TransitionRow& row : kTransitions) {
        if (row.source == state && row.event == event && TryRow(row)) {
            return true;
        }
    }
    return false;
}
