bool DispatchTimeout(Event timeout, unsigned generation) {
    const int index = TimerIndex(timeout);
    if (index < 0 || !timerArmed_[index] || timerGeneration_[index] != generation) {
        return false;
    }
    args_ = nullptr;
    const bool handled = DispatchCore(timeout);
    args_ = nullptr;
    DrainQueue();
    return handled;
}
