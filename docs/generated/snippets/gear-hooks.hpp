// Variables used by the hook code.
double down_th{};   // local, Inherit: From definition in chart
double up_th{};   // local, Inherit: From definition in chart
double delta{};   // local, Inherit: From definition in chart
double speed{};   // local, Inherit: From definition in chart
double gear{};   // local, Inherit: From definition in chart

void gear_stateDuring() override {
    speed = max(0,min(speed+delta,100));
}

void action27() override {
    Post(Event::UP);
}
