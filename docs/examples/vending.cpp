// Tutorial 4: VendingMachine (switch-based C++ with trace and event queue).
#include <cstdio>

#include "VendingMachine.hpp"

using Demo::VendingMachine;

class Machine : public VendingMachine {
  public:
    // Demo timer: remembers the running timeout so main() can let it elapse.
    void Elapse() {
        if (timerRunning_) {
            timerRunning_ = false;
            std::printf("timer elapsed -> DispatchTimeout(%s, %u)\n", EventName(timer_), generation_);
            DispatchTimeout(timer_, generation_);
        }
    }

  protected:
    static constexpr int kPrice     = 150;
    static constexpr int kMaxCredit = 500;

    void StartTimer(Event timeout, unsigned milliseconds, unsigned generation) override {
        std::printf("    StartTimer(%s, %u, %u)\n", EventName(timeout), milliseconds, generation);
        timer_        = timeout;
        generation_   = generation;
        timerRunning_ = true;
    }
    void CancelTimer(Event timeout) override {
        std::printf("    CancelTimer(%s)\n", EventName(timeout));
        timerRunning_ = false;
    }

    // Choice guards are evaluated before the transition's actions run, so the coin is not yet credited.
    bool hasEnoughCredit(int cents) override { return credit_ + cents >= kPrice; }
    bool inStock(int item) override          { return item < 3; }
    bool hasChange() override                { return credit_ > 0; }

    void addCredit(int cents) override {
        credit_ += cents;
        std::printf("    addCredit(%d) -> credit %d\n", cents, credit_);
        if (credit_ > kMaxCredit) {
            std::puts("    credit limit exceeded: Post(Cancel)");
            Post(Event::Cancel);
        }
    }
    void vend(int item) override {
        credit_ -= kPrice;
        std::printf("    vend(%d) -> credit %d\n", item, credit_);
    }
    void refund() override {
        std::printf("    refund() -> %d returned\n", credit_);
        credit_ = 0;
    }
    void giveChange() override {
        std::printf("    giveChange() -> %d returned\n", credit_);
        credit_ = 0;
    }
    void selfTest() override    { std::puts("    selfTest()"); }
    void showWelcome() override { std::puts("    showWelcome()"); }
    void showCredit() override  { std::puts("    showCredit()"); }
    void showSelect() override  { std::puts("    showSelect()"); }
    void openFlap() override    { std::puts("    openFlap()"); }
    void closeFlap() override   { std::puts("    closeFlap()"); }

    void Trace(TraceKind kind, const char* name) override {
        static const char* const kinds[] = { "start", "event", "ignored", "transition", "exit", "enter" };
        std::printf("  %-10s %s\n", kinds[static_cast<int>(kind)], name);
    }

  private:
    int      credit_       = 0;
    Event    timer_        = Event::Coin;
    unsigned generation_   = 0;
    bool     timerRunning_ = false;
};

int main() {
    Machine m;
    std::puts("Start()");
    m.Start();
    std::puts("DispatchCoin(100)");
    m.DispatchCoin(100);
    m.Elapse();
    std::puts("DispatchCoin(100)");
    m.DispatchCoin(100);
    std::puts("DispatchCoin(50)");
    m.DispatchCoin(50);
    std::puts("DispatchSelect(7)");
    m.DispatchSelect(7);
    std::puts("DispatchSelect(1)");
    m.DispatchSelect(1);
    m.Elapse();
    std::puts("DispatchCoin(200)");
    m.DispatchCoin(200);
    std::puts("DispatchCoin(400)");
    m.DispatchCoin(400);
    std::printf("final state: %s\n", VendingMachine::StateName(m.Current()));
}
