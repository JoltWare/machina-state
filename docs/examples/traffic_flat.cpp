// Tutorial 1: drive the generated flat TrafficLight (switch-based C++).
#include <cstdio>

#include "TrafficLightFlat_switch.hpp"

class ConsoleTrafficLight : public Demo::TrafficLight {
  protected:
    void redOn() override     { std::puts("  [RED    on ]"); }
    void redOff() override    { std::puts("  [RED    off]"); }
    void yellowOn() override  { std::puts("  [YELLOW on ]"); }
    void yellowOff() override { std::puts("  [YELLOW off]"); }
    void greenOn() override   { std::puts("  [GREEN  on ]"); }
    void greenOff() override  { std::puts("  [GREEN  off]"); }
};

int main() {
    ConsoleTrafficLight light;
    light.Start();
    std::printf("state: %s\n", Demo::TrafficLight::StateName(light.Current()));

    for (int tick = 1; tick <= 4; ++tick) {
        light.Dispatch(Demo::TrafficLight::Event::Timer);
        std::printf("tick %d -> state: %s\n", tick, Demo::TrafficLight::StateName(light.Current()));
    }
}
