bool HandleEvent(State state, Event event) {
    switch (state) {
        case State::Red:
            switch (event) {
                case Event::Timer:
                    ExitState(State::Red);
                    EnterDown(State::None, State::Green);
                    return true;
                default:
                    break;
            }
            break;
        case State::Green:
            switch (event) {
                case Event::Timer:
                    ExitState(State::Green);
                    EnterDown(State::None, State::Yellow);
                    return true;
                default:
                    break;
            }
            break;
        case State::Yellow:
            switch (event) {
                case Event::Timer:
                    ExitState(State::Yellow);
                    EnterDown(State::None, State::Red);
                    return true;
                default:
                    break;
            }
            break;
        default:
            break;
    }
    return false;
}
