// Tutorial 2: hierarchical TrafficLight (table-based C++ with tracing).
#include <cstdio>

#include "TrafficLight.hpp"

using Demo::TrafficLight;

class Light : public TrafficLight {
  protected:
    void redOn() override        { std::puts("    redOn()"); }
    void redOff() override       { std::puts("    redOff()"); }
    void yellowOn() override     { std::puts("    yellowOn()"); }
    void yellowOff() override    { std::puts("    yellowOff()"); }
    void greenOn() override      { std::puts("    greenOn()"); }
    void greenOff() override     { std::puts("    greenOff()"); }
    void flashOn() override      { std::puts("    flashOn()"); }
    void flashOff() override     { std::puts("    flashOff()"); }
    void logFault() override     { std::puts("    logFault()"); }
    void shortenGreen() override { std::puts("    shortenGreen()"); }

    void Trace(TraceKind kind, const char* name) override {
        static const char* const kinds[] = { "start", "event", "ignored", "transition", "exit", "enter" };
        std::printf("  %-10s %s\n", kinds[static_cast<int>(kind)], name);
    }
};

int main() {
    Light light;
    light.Start();
    const TrafficLight::Event script[] = {
        TrafficLight::Event::PowerOn, TrafficLight::Event::Timer, TrafficLight::Event::PedestrianRequest,
        TrafficLight::Event::Fault,   TrafficLight::Event::Repair, TrafficLight::Event::PowerOff,
    };
    for (TrafficLight::Event e : script) {
        std::printf("Dispatch(%s)\n", TrafficLight::EventName(e));
        light.Dispatch(e);
    }
    std::printf("final state: %s\n", TrafficLight::StateName(light.Current()));
}
