void EnterHistory(State state, bool deep) {
    const std::size_t first = FirstRegionOf(state);
    for (std::size_t region = first; region < first + RegionsOf(state); ++region) {
        const State remembered = history_[region];
        if (remembered == State::None) {
            EnterRegion(region);
        } else if (deep) {
            EnterState(remembered);
            EnterHistory(remembered, true);
        } else {
            EnterDown(state, remembered, false);
        }
    }
}
