public bool DispatchEnterCode(int code)
{
    Lock();
    try
    {
        EnterCode_code = code;
        return DispatchCore(Event.EnterCode);
    }
    finally
    {
        Unlock();
    }
}

public bool DispatchReset(int code)
{
    Lock();
    try
    {
        Reset_code = code;
        return DispatchCore(Event.Reset);
    }
    finally
    {
        Unlock();
    }
}
