// Gear_LogicHooks: implementation of the hooks of Gear_Logic, generated once by MachinaState.
// This file is yours: MachinaState never overwrites it.
// Hook bodies hold the code each hook replaced on import, copied as written; adapt it where needed
// (helper functions, bus types and literals of the source tool are not translated).
#pragma once

#include "Gear_Logic.hpp"

class Gear_LogicHooks : public Gear_Logic {
  protected:
    // Variables used by the hook code.
    double down_th{};   // local, Inherit: From definition in chart
    double up_th{};   // local, Inherit: From definition in chart
    double delta{};   // local, Inherit: From definition in chart
    double speed{};   // local, Inherit: From definition in chart
    double gear{};   // local, Inherit: From definition in chart

    // transition 28
    bool guard28() override {
        return speed > up_th;
    }

    // transition 21
    bool guard21() override {
        return speed < down_th;
    }

    // transition 24
    bool guard24() override {
        return speed > down_th;
    }

    // transition 25
    bool guard25() override {
        return speed <= down_th;
    }

    // transition 26
    bool guard26() override {
        return speed < up_th;
    }

    // transition 27
    bool guard27() override {
        return speed >= up_th;
    }

    // state gear_state during
    void gear_stateDuring() override {
        speed = max(0,min(speed+delta,100));
    }

    // state first entry
    void firstEntry() override {
        gear=1;
    }

    // state second entry
    void secondEntry() override {
        gear=2;
    }

    // state third entry
    void thirdEntry() override {
        gear=3;
    }

    // state fourth entry
    void fourthEntry() override {
        gear=4;
    }

    void computeThresholds() override {
        // TODO
    }

    // transition 25
    void action25() override {
        Post(Event::DOWN);
    }

    // transition 27
    void action27() override {
        Post(Event::UP);
    }
};
