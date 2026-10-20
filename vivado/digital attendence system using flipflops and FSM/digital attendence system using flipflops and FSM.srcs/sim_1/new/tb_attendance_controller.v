`timescale 1ns/1ps
module tb_attendance_controller;
    reg clk=0, reset=1, scan_valid=0;
    reg [5:0] capture_id=0; reg [4:0] hour=8; reg [5:0] minute=0, second=0;
    wire status_valid; wire [2:0] status_code; wire [63:0] attendance_bits; wire [3:0] state_dbg;

    attendance_controller dut(.clk(clk),.reset(reset),.scan_valid(scan_valid),
        .capture_id(capture_id),.hour(hour),.minute(minute),.second(second),
        .status_valid(status_valid),.status_code(status_code),
        .attendance_bits(attendance_bits),.state_dbg(state_dbg));

    always #5 clk = ~clk;

    task scan(input [5:0] id, input [4:0] h, input [5:0] m);
    begin
        @(negedge clk); capture_id=id; hour=h; minute=m; scan_valid=1;
        @(negedge clk); scan_valid=0;
        wait(status_valid); @(negedge clk);
        $display("t=%0t id=%0d %0d:%0d -> status=%0d bits=%h", $time, id, h, m, status_code, attendance_bits);
        repeat(3) @(negedge clk);
    end endtask

    initial begin
        repeat(3) @(negedge clk); reset=0;
        scan(6'd10, 5'd8, 6'd30);   // expect 4 recorded
        scan(6'd10, 5'd8, 6'd31);   // expect 1 already present
        scan(6'd62, 5'd9, 6'd14);   // expect 3 outside window
        scan(6'd63, 5'd8, 6'd10);   // expect 2 invalid id
        scan(6'd5,  5'd8, 6'd5);    // expect 4 recorded
        $finish;
    end
endmodule