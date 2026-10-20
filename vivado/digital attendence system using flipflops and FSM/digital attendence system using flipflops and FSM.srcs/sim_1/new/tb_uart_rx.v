`timescale 1ns/1ps
module tb_uart_rx;
    localparam CPB = 16;
    reg clk=0, rst=1, rx=1; wire [7:0] data; wire valid;
    uart_rx #(.CLKS_PER_BIT(CPB)) dut(.clk(clk),.rst(rst),.rx(rx),.data(data),.valid(valid));
    always #5 clk=~clk;
    task send(input [7:0] b); integer i; begin
        rx=0; repeat(CPB) @(posedge clk);
        for(i=0;i<8;i=i+1) begin rx=b[i]; repeat(CPB) @(posedge clk); end
        rx=1; repeat(CPB) @(posedge clk);
    end endtask
    initial begin
        repeat(4) @(posedge clk); rst=0;
        send(8'h0A); send(8'h3E);
        repeat(20) @(posedge clk); $finish;
    end
    always @(posedge clk) if (valid) $display("RX got %h", data);
endmodule