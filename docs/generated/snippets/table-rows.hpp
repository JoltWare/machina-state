// source, event, guard, negate guard, action, target, least common ancestor
inline const TrafficLight::TransitionRow TrafficLight::kTransitions[3] = {
    { State::Red, Event::Timer, nullptr, false, nullptr, State::Green, State::None },
    { State::Green, Event::Timer, nullptr, false, nullptr, State::Yellow, State::None },
    { State::Yellow, Event::Timer, nullptr, false, nullptr, State::Red, State::None },
};
