// vm-hinge: set or read the iPhone Duo simulator's hinge angle. Runs inside the simulator
// (`xcrun simctl spawn <udid> vm-hinge …`) and posts the vendor-defined HID event that Xcode's
// Device Hub sends from its hinge slider; reads the angle back from CoreMotion to confirm. Private
// interfaces (the mechanism as published by github.com/artemnovichkov/hinge, MIT): a new Xcode may
// break it, so the daemon checks every move and falls back when one doesn't land.
//
//   vm-hinge set <degrees 0…180> [confirm-seconds]   exit 0 once CoreMotion reports the angle
//   vm-hinge get                                     prints the angle
//   vm-hinge orient <portrait|landscape-left|landscape-right|pud>   Device Hub's rotate event (a foldable
//                                                    ignores devicectl's; check it with devicectl orientation get)
#import <Foundation/Foundation.h>
#include <mach/mach_time.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef struct __IOHIDEvent *IOHIDEventRef;
typedef struct __IOHIDEventSystemClient *IOHIDEventSystemClientRef;
extern IOHIDEventRef IOHIDEventCreateVendorDefinedEvent(CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t, const uint8_t *, CFIndex, uint32_t);
extern IOHIDEventSystemClientRef IOHIDEventSystemClientCreateWithType(CFAllocatorRef, int, CFDictionaryRef);
extern void IOHIDEventSystemClientDispatchEvent(IOHIDEventSystemClientRef, IOHIDEventRef);
extern CFDataRef IOCFSerialize(CFTypeRef, CFOptionFlags);

@interface CMAngle : NSObject
- (float)angleDegrees;
@end
@interface CMAngleManager : NSObject
+ (BOOL)isAvailable;
- (void)startAngleUpdatesToQueue:(NSOperationQueue *)queue handler:(void (^)(CMAngle *angle))handler;
- (void)stopAngleUpdates;
@end

static void send(NSString *source, NSString *type, id value) {
    IOHIDEventSystemClientRef client = IOHIDEventSystemClientCreateWithType(NULL, 4, NULL);
    if (!client) { fprintf(stderr, "vm-hinge: no HID event client\n"); exit(1); }
    NSDictionary *payload = @{ @"provider": @"com.apple.Virtualization.VirtualMachines", @"source": source, @"type": type, @"value": value };
    CFDataRef data = IOCFSerialize((__bridge CFTypeRef)payload, 1);
    if (!data) { fprintf(stderr, "vm-hinge: couldn't serialize the event\n"); exit(1); }
    IOHIDEventRef event = IOHIDEventCreateVendorDefinedEvent(NULL, mach_absolute_time(), 0xFF61, 0x5B, 0, CFDataGetBytePtr(data), CFDataGetLength(data), 0);
    if (event) { IOHIDEventSystemClientDispatchEvent(client, event); CFRelease(event); }
    CFRelease(data);
}

static void sendAngle(double degrees) { send(@"hinge-slider-control", @"range", @(degrees)); }

/// Waits up to `timeout` for an angle `accept` takes; sends the angle first when `target` is set.
static int watch(double timeout, BOOL send, double target, BOOL (^accept)(double)) {
    Class manager = NSClassFromString(@"CMAngleManager");
    if (!manager || ![manager isAvailable]) { fprintf(stderr, "vm-hinge: this simulator has no hinge\n"); return 2; }
    id m = [[manager alloc] init];
    __block BOOL done = NO;
    [m startAngleUpdatesToQueue:[NSOperationQueue new] handler:^(CMAngle *a) { if (!done && accept([a angleDegrees])) done = YES; }];
    if (send) sendAngle(target);
    CFAbsoluteTime deadline = CFAbsoluteTimeGetCurrent() + timeout;
    while (!done && CFAbsoluteTimeGetCurrent() < deadline) CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, false);
    [m stopAngleUpdates];
    return done ? 0 : 1;
}

int main(int argc, char **argv) {
    @autoreleasepool {
        if (argc == 2 && strcmp(argv[1], "get") == 0) {
            __block double angle = 0;
            int r = watch(2, NO, 0, ^BOOL(double d) { angle = d; return YES; });
            if (r == 0) printf("%.1f\n", angle);
            return r;
        }
        if (argc >= 3 && strcmp(argv[1], "set") == 0) {
            double target = fmin(fmax(atof(argv[2]), 0), 180);
            double confirm = argc >= 4 ? atof(argv[3]) : 3;
            int r = watch(confirm, YES, target, ^BOOL(double d) { return fabs(d - target) <= 0.5; });
            if (r == 1) fprintf(stderr, "vm-hinge: the hinge didn't reach %.1f in %.1f s\n", target, confirm);
            usleep(20000);
            return r;
        }
        if (argc == 3 && strcmp(argv[1], "orient") == 0) {
            send(@"orientation-picker-control", @"enum", [NSString stringWithUTF8String:argv[2]]);
            usleep(20000);
            return 0;
        }
        fprintf(stderr, "usage: vm-hinge set <degrees> [confirm-seconds] | vm-hinge get | vm-hinge orient <orientation>\n");
        return 64;
    }
}
