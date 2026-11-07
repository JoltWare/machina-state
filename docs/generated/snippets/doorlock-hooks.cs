/// <summary>Acquires mutual exclusion around every public member (e.g. Monitor.Enter on a private object).</summary>
/// <remarks>Hooks must not call public members of this class unless the lock is re-entrant.</remarks>
protected abstract void Lock();
/// <summary>Releases the lock acquired by <see cref="Lock"/>.</summary>
protected abstract void Unlock();
/// <summary>Override to log state machine activity.</summary>
protected virtual void Trace(TraceKind kind, string name)
{
}
protected abstract bool isValidCode(int code);
protected abstract bool tooManyAttempts(int code);
protected abstract bool isAdminCode(int code);
protected abstract void engageBolt();
protected abstract void releaseBolt();
protected abstract void sirenOn();
protected abstract void sirenOff();
protected abstract void resetAttempts(int code);
protected abstract void countFailure(int code);
