`timescale 1ns/1ps
module tb_uart_tx;
    localparam CPB = 16;
    reg clk=0, rst=1, start=0; reg [7:0] data=0; wire tx, busy;
    uart_tx #(.CLKS_PER_BIT(CPB)) dut(.clk(clk),.rst(rst),.start(start),.data(data),.tx(tx),.busy(busy));
    always #5 clk=~clk;
    initial begin
        repeat(4) @(posedge clk); rst=0;
        @(posedge clk); data=8'h04; start=1; @(posedge clk); start=0;
        wait(!busy); repeat(5) @(posedge clk);
        data=8'hA5; start=1; @(posedge clk); start=0;
        wait(!busy); repeat(5) @(posedge clk); $finish;
    end
endmodule