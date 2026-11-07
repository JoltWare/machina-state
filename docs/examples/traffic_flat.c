/* The Tutorial 1 traffic light generated as C99 (switch-based, with Trace). */
#include <stdio.h>

#include "TrafficLight.h"

/* Application data reached through the context pointer. */
typedef struct {
    int switches;
} Lamps;

static void Show(void* context, const char* text) {
    Lamps* lamps = (Lamps*)context;
    lamps->switches++;
    printf("  [%s]\n", text);
}

static void redOn(void* c)     { Show(c, "RED    on "); }
static void redOff(void* c)    { Show(c, "RED    off"); }
static void yellowOn(void* c)  { Show(c, "YELLOW on "); }
static void yellowOff(void* c) { Show(c, "YELLOW off"); }
static void greenOn(void* c)   { Show(c, "GREEN  on "); }
static void greenOff(void* c)  { Show(c, "GREEN  off"); }

static void Trace(void* context, Demo_TrafficLight_TraceKind kind, const char* name) {
    (void)context;
    if (kind == Demo_TrafficLight_Trace_Transition) {
        printf("transition %s\n", name);
    }
}

int main(void) {
    static const Demo_TrafficLight_Hooks hooks = {
        .redOn = redOn,
        .redOff = redOff,
        .greenOn = greenOn,
        .greenOff = greenOff,
        .yellowOn = yellowOn,
        .yellowOff = yellowOff,
        .Trace = Trace,
    };
    Lamps lamps = { 0 };
    Demo_TrafficLight light;

    Demo_TrafficLight_Init(&light, &hooks, &lamps);
    Demo_TrafficLight_Start(&light);
    for (int tick = 1; tick <= 3; ++tick) {
        Demo_TrafficLight_Dispatch(&light, Demo_TrafficLight_Event_Timer);
        printf("tick %d -> state: %s\n", tick, Demo_TrafficLight_StateName(Demo_TrafficLight_Current(&light)));
    }
    printf("%d lamp switches\n", lamps.switches);
    return 0;
}
